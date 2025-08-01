// modules/processor.js

import path from 'path';
import fs from 'fs/promises';
import chalk from 'chalk';
import CONFIG from '../config.js';
import logger from '../utils/logger.js';
import { createSafeArticleFilename } from '../utils/helpers.js';
import { extractArticleContent, callLLM } from '../services/network.js';

function robustParseLLMResponse(llmResponse) {
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error(`LLM响应中未找到有效的JSON对象结构。收到的内容: "${llmResponse}"`);
    }
    const jsonString = jsonMatch[0];

    let data;
    try {
        data = JSON.parse(jsonString);
    } catch (error) {
        logger.error(`JSON解析失败。原始文本: "${jsonString}"`);
        throw new Error(`LLM返回的不是一个有效的JSON格式: ${error.message}`);
    }

    const { title, conciseSummary, keywords, category, detailedSummary } = data;
    if (!title || typeof title !== 'string' || title.trim() === '') throw new Error("JSON数据中缺少有效的'title'字段。");
    if (!detailedSummary || typeof detailedSummary !== 'string' || detailedSummary.trim() === '') throw new Error("JSON数据中缺少有效的'detailedSummary'字段。");
    if (!keywords || !Array.isArray(keywords)) throw new Error("JSON数据中'keywords'字段必须是一个数组。");

    const newTitle = title.trim();
    let finalConciseSummary = (conciseSummary || '').trim();
    const finalKeywords = keywords.map(k => String(k).trim()).filter(Boolean);
    const finalCategory = category || '其他';

    if (!finalConciseSummary && detailedSummary.trim().length > 0) {
        logger.warn(`未能从JSON中获取'conciseSummary'，将使用详细摘要的第一句话作为替代。`);
        const firstSentence = detailedSummary.trim().split(/[。！？]/)[0];
        if (firstSentence) finalConciseSummary = `${firstSentence.trim()}。`;
    }

    return { title: newTitle, conciseSummary: finalConciseSummary, keywords: finalKeywords, category: finalCategory, detailedSummary: detailedSummary.trim() };
}


async function processSingleArticle(articleMeta, progressCallback = () => {}) {
    const { title: originalTitle, content, url, isCluster } = articleMeta;
    logger.debug(`开始处理议题: 《${originalTitle}》`);
    progressCallback(`深度处理中`);
    const { system, user } = CONFIG.prompts.processArticleSingleCall(content, originalTitle, isCluster);
    const llmResponse = await callLLM(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        0.5,
        CONFIG.llm.longRequestTimeout
    );

    let processedData;
    try {
        processedData = robustParseLLMResponse(llmResponse);
    } catch (parseError) {
        logger.error(`解析LLM的JSON响应失败: ${parseError.message}`, { articleTitle: originalTitle });
        logger.debug(`导致解析失败的LLM原文: \n---\n${llmResponse}\n---`);
        throw new Error(`解析LLM响应失败: ${parseError.message}`);
    }
    
    processedData.originalTitle = originalTitle;

    if (!Object.keys(CONFIG.output.categoryEmojis).includes(processedData.category)) {
        logger.warn(`议题《${originalTitle}》的新分类 "${processedData.category}" 不在预设中, 将使用默认分类“其他”。`);
        processedData.category = '其他';
    }
    if (!processedData.title || !processedData.detailedSummary) throw new Error('经过解析和验证后，响应中仍缺少必要的标题或详细摘要。');
    if (!processedData.conciseSummary) logger.warn(`议题《${originalTitle}》最终未能生成有效的一句话摘要。`);

    logger.info(`议题《${originalTitle}》处理成功，新标题为《${processedData.title}》！`);
    return processedData;
}


/**
 * (已重构) 串行处理入选的文章议题，计算时间加权分，并保存独立报告。
 */
export async function processAndSummarizeArticles(articles, dailyOutputDir, progressBar) {
    if (articles.length === 0) {
        logger.info('没有需要处理的文章。');
        return [];
    }

    const individualArticlesDir = path.join(dailyOutputDir, 'articles_markdown');
    await fs.mkdir(individualArticlesDir, { recursive: true });
    logger.info(`单篇文章/议题的 Markdown 报告将保存在: ${individualArticlesDir}`);

    let processingQueue = [...articles];
    const successfulArticles = [];
    const failedArticles = new Map();
    let overallRetryCount = 0;

    while (processingQueue.length > 0 && overallRetryCount < CONFIG.processing.maxOverallRetries) {
        if (overallRetryCount > 0) {
            console.log(chalk.yellow.bold(`\n--- 开始第 ${overallRetryCount} 轮失败重试 (${processingQueue.length}篇) ---`));
            const delay = CONFIG.llm.retryDelay * Math.pow(2, overallRetryCount - 1);
            console.log(chalk.gray(`(等待 ${delay / 1000} 秒后重试...)`));
            await new Promise(res => setTimeout(res, delay));
        }

        const currentBatch = [...processingQueue];
        processingQueue = [];

        for (const [index, meta] of currentBatch.entries()) {
            const shortTitle = (meta.title || '未知标题').slice(0, 35);
            progressBar.setTotal(currentBatch.length);
            progressBar.update(index, { status: `[提取原文] ${shortTitle}...` });
            
            try {
                const isCluster = meta.clusterUrls && meta.clusterUrls.length > 1;
                const urlsToFetch = meta.clusterUrls || [meta.url];
                let combinedContent = '';
                let contentCount = 0;
                let latestDate = null;

                for (const [subIndex, url] of urlsToFetch.entries()) {
                    const { title: articleTitle, content, date_published } = await extractArticleContent(url);
                    
                    // 更新为最近的发布日期
                    if (date_published) {
                        const articleDate = new Date(date_published);
                        if (!latestDate || articleDate > latestDate) {
                            latestDate = articleDate;
                        }
                    }

                    if (content.length > CONFIG.processing.minContentLength / urlsToFetch.length) {
                        if(isCluster) {
                            combinedContent += `--- [相关文章 ${subIndex + 1}/${urlsToFetch.length}] 原始标题: ${articleTitle} ---\n\n${content}\n\n`;
                        } else {
                            combinedContent += content;
                        }
                        contentCount++;
                    }
                }

                if (contentCount === 0) {
                    throw new Error(`正文内容均过短, 已跳过。`);
                }
                
                const articleDataForLLM = { 
                    title: meta.title, 
                    content: combinedContent, 
                    url: meta.url,
                    isCluster: isCluster 
                };

                const processedData = await processSingleArticle(articleDataForLLM, (taskName) => {
                    progressBar.update(index, { status: `[${taskName}] ${shortTitle}...` });
                });

                const safeFilename = createSafeArticleFilename(meta.rank - 1, processedData.title);
                const articleFilePath = path.join(individualArticlesDir, safeFilename);
                
                // --- (新增) 计算新颖度得分 ---
                let recencyBonus = 0;
                if (latestDate) {
                    const daysAgo = (new Date() - latestDate) / (1000 * 60 * 60 * 24);
                    if (daysAgo >= 0 && daysAgo <= CONFIG.processing.recencyBonus.maxDays) {
                        recencyBonus = Math.round(CONFIG.processing.recencyBonus.maxBonus * (1 - (daysAgo / CONFIG.processing.recencyBonus.maxDays)));
                    }
                }

                const finalScore = (meta.tournamentScore || 0) + recencyBonus;
                logger.info(`议题《${processedData.title}》 - 锦标赛得分: ${meta.tournamentScore}, 新颖度加分: ${recencyBonus}, 最终得分: ${finalScore}`);
                
                const finalResult = { 
                    ...meta, 
                    ...processedData,
                    publishedDate: latestDate ? latestDate.toISOString().slice(0, 10) : null,
                    recencyBonus: recencyBonus,
                    finalScore: finalScore
                };
                
                let sourceLinks = '';
                if(isCluster) {
                    sourceLinks = finalResult.clusterUrls.map((u, i) => `- [${finalResult.clusterTitles[i]}](${u})`).join('\n');
                } else {
                    sourceLinks = `[${finalResult.originalTitle}](${finalResult.url})`;
                }

                const articleMarkdown = `
# ${finalResult.title}
- **一句话摘要**: ${finalResult.conciseSummary || 'N/A'}
- **核心词**: ${finalResult.keywords.join('、') || 'N/A'}
- **发布日期**: ${finalResult.publishedDate || '未知'}
- **综合得分**: ${finalResult.finalScore} (锦标赛: ${finalResult.tournamentScore}, 新颖度: ${finalResult.recencyBonus})
- **原文链接**: ${isCluster ? '\n' + sourceLinks : sourceLinks}

---

### 详细内容
${finalResult.detailedSummary}

---

*报告生成时间: ${new Date().toLocaleString('zh-CN')}*
*原始代表标题: ${finalResult.originalTitle}*
`.trim();

                await fs.writeFile(articleFilePath, articleMarkdown);
                logger.info(`[处理成功] ${safeFilename}`);

                successfulArticles.push(finalResult);
                progressBar.update(index + 1, { status: `[处理完成] ${chalk.green(finalResult.title.slice(0, 30))}...` });

            } catch (error) {
                const errorMessage = error.message || '未知错误';
                logger.error(`议题处理失败: ${meta.url}`, { error: errorMessage });
                failedArticles.set(meta.url, { ...meta, message: errorMessage });
                processingQueue.push(meta);
                progressBar.update(index + 1, { status: `[处理失败] ${chalk.red(shortTitle)}... 将重试` });
            }
        }
        overallRetryCount++;
    }

    progressBar.stop();
    
    if (processingQueue.length > 0) {
        console.log(chalk.red.bold(`\n❌ 经过 ${CONFIG.processing.maxOverallRetries} 轮尝试后，仍有 ${processingQueue.length} 篇议题处理失败:`));
        processingQueue.forEach(fail => {
            const failReason = failedArticles.get(fail.url)?.message || '未知错误';
            console.log(chalk.red(`     - ${fail.title}: ${failReason}`));
        });
    }

    return successfulArticles;
}