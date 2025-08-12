// modules/processor.js

import path from 'path';
import fs from 'fs/promises';
import chalk from 'chalk';
import CONFIG from '../config.js';
import logger from '../utils/logger.js';
import { createSafeArticleFilename } from '../utils/helpers.js';
import { extractArticleContent, callLLM } from '../services/network.js';

/**
 * 安全地解析从LLM返回的JSON响应。
 * @param {string} llmResponse - LLM的原始响应文本
 * @returns {object} - 经过验证的、包含所需字段的JSON对象
 * @throws 如果解析失败或缺少关键字段，则抛出错误
 */
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

/**
 * 内部函数，处理单次LLM调用和解析。
 * @param {object} articleContent - 包含内容和原始标题的对象
 * @returns {Promise<object>} - 处理后的数据
 */
async function processArticleWithLLM(articleContent, originalTitle, isCluster, latestDate) {
    logger.debug(`开始处理议题: 《${originalTitle}》`);
    const { system, user } = CONFIG.prompts.processArticleSingleCall(articleContent, originalTitle, isCluster, latestDate);
    const llmResponse = await callLLM(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        0.5,
        CONFIG.llm.longRequestTimeout
    );
    if (llmResponse.includes('false')) {
        throw new Error('当前文章不是近期内容')
    }

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

    logger.info(`议题《${originalTitle}》LLM处理成功，新标题为《${processedData.title}》！`);
    return processedData;
}


/**
 * (已重构) 尝试处理单篇文章议题，内置重试逻辑。
 * 如果在所有尝试后仍然失败，将抛出错误，由主流程捕获。
 * @param {object} articleMeta - 从排名模块传入的单篇文章元数据
 * @param {number} rankIndex - 该文章在最终成功列表中的排名索引，用于生成文件名
 * @param {string} dailyOutputDir - 当日输出目录
 * @returns {Promise<object>} - 包含所有处理后数据的完整文章对象
 * @throws 如果所有重试都失败，则抛出错误
 */
export async function attemptToProcessArticle(articleMeta, rankIndex, dailyOutputDir) {
    const individualArticlesDir = path.join(dailyOutputDir, 'articles_markdown');
    await fs.mkdir(individualArticlesDir, { recursive: true });

    for (let attempt = 1; attempt <= CONFIG.processing.maxOverallRetries; attempt++) {
        try {
            // 1. 提取原文内容
            const isCluster = articleMeta.clusterUrls && articleMeta.clusterUrls.length > 1;
            const urlsToFetch = isCluster ? articleMeta.clusterUrls : [articleMeta.url];
            let combinedContent = '';
            let contentCount = 0;
            let latestDate = null;

            for (const [subIndex, url] of urlsToFetch.entries()) {
                const { title: articleTitle, content, date_published } = await extractArticleContent(url);
                
                if (date_published) {
                    const articleDate = new Date(date_published);
                    if (!latestDate || articleDate > latestDate) latestDate = articleDate;
                }

                if (content.length > CONFIG.processing.minContentLength / urlsToFetch.length) {
                    combinedContent += isCluster 
                        ? `--- [相关文章 ${subIndex + 1}/${urlsToFetch.length}] 原始标题: ${articleTitle} ---\n\n${content}\n\n`
                        : content;
                    contentCount++;
                }
            }

            if (contentCount === 0) throw new Error('所有源文章的正文内容均过短, 已跳过');

            // 2. 调用LLM进行深度处理
            const processedData = await processArticleWithLLM(combinedContent, articleMeta.title, isCluster, latestDate);

            // 3. 计算新颖度加分和最终得分
            let recencyBonus = 0;
            if (latestDate) {
                const daysAgo = (new Date() - latestDate) / (1000 * 60 * 60 * 24);
                if (daysAgo >= 0 && daysAgo <= CONFIG.processing.recencyBonus.maxDays) {
                    recencyBonus = Math.round(CONFIG.processing.recencyBonus.maxBonus * (1 - (daysAgo / CONFIG.processing.recencyBonus.maxDays)));
                }
            }
            const finalScore = (articleMeta.tournamentScore || 0) + recencyBonus;
            logger.info(`议题《${processedData.title}》 - 锦标赛得分: ${articleMeta.tournamentScore}, 新颖度加分: ${recencyBonus}, 最终得分: ${finalScore}`);

            // 4. 整合最终结果对象
            const finalResult = { 
                ...articleMeta, 
                ...processedData,
                publishedDate: latestDate ? latestDate.toISOString().slice(0, 10) : null,
                recencyBonus,
                finalScore
            };

            // 5. 生成并保存独立的Markdown文件
            const safeFilename = createSafeArticleFilename(rankIndex, finalResult.title);
            const articleFilePath = path.join(individualArticlesDir, safeFilename);
            
            const sourceLinks = isCluster
                ? finalResult.clusterUrls.map((u, i) => `- [${finalResult.clusterTitles[i]}](${u})`).join('\n')
                : `[${finalResult.originalTitle}](${finalResult.url})`;

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
            
            // 成功，返回完整结果
            return finalResult;

        } catch (error) {
            logger.warn(`处理《${articleMeta.title}》第 ${attempt}/${CONFIG.processing.maxOverallRetries} 次尝试失败: ${error.message}`);
            if (attempt === CONFIG.processing.maxOverallRetries) {
                // 这是最后一次尝试，向上抛出错误，通知主流程此文章处理失败
                throw new Error(`文章《${articleMeta.title}》在所有重试后仍然失败。`);
            }
            // 等待指数退避时间后重试
            const delay = CONFIG.llm.retryDelay * Math.pow(2, attempt - 1);
            await new Promise(res => setTimeout(res, delay));
        }
    }
}