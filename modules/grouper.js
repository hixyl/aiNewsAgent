// modules/grouper.js

import _ from 'lodash';
import chalk from 'chalk';
import pLimit from 'p-limit';
import CONFIG from '../config.js';
import logger from '../utils/logger.js';
import { callLLM } from '../services/network.js';

/**
 * 安全地解析LLM返回的JSON。
 * @param {string} responseText - LLM的原始响应文本
 * @returns {object | Array} - 解析后的JSON对象或数组
 * @throws 如果解析失败或格式不符，则抛出错误
 */
function robustJsonParse(responseText) {
    const jsonMatch = responseText.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error(`响应中未找到有效的JSON结构。收到: "${responseText}"`);
    try {
        return JSON.parse(jsonMatch[0]);
    } catch (error) {
        try {
            const fixedJson = jsonMatch[0].replace(/,\s*([\}\]])/g, '$1');
            return JSON.parse(fixedJson);
        } catch (finalError) {
             throw new Error(`JSON解析失败: ${finalError.message}. Raw: ${jsonMatch[0]}`);
        }
    }
}

/**
 * (已重构) 使用“广泛聚类后验证拆分”的三阶段策略，对文章进行语义聚类和去重。
 * @param {Array<object>} articles - 候选文章列表。
 * @param {import('cli-progress').SingleBar} progressBar - 进度条实例。
 * @returns {Promise<Array<object>>} - 经过聚类和去重后的最终议题列表。
 */
export async function groupAndDeduplicateArticles(articles, progressBar) {
    if (articles.length < 2) return articles;

    console.log(chalk.cyan.bold('\n启动三阶段聚类流程 (广泛聚类 -> 验证拆分 -> 定型)...'));
    const { qualificationConcurrency, groupingBatchSize } = CONFIG.ranking;
    const limit = pLimit(qualificationConcurrency);
    
    let articlesWithTempId = articles.map((article, index) => ({
        ...article,
        tempId: index
    }));
    let articleMap = _.keyBy(articlesWithTempId, 'tempId');


    // --- 阶段一: 广泛主题聚类 ---
    console.log(chalk.cyan.bold('\n--- 阶段 1/3: 广泛主题聚类 ---'));
    progressBar.start(articles.length, 0, { status: "进行初步的广泛聚类..." });

    const batches = _.chunk(articlesWithTempId, groupingBatchSize * 2);
    let roughClusters = {};
    let clusterCounter = 0;

    for (const batch of batches) {
        try {
            const { system, user } = CONFIG.prompts.initialBroadClustering(batch);
            const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.0);
            const batchClusters = robustJsonParse(responseText);

            for (const topic in batchClusters) {
                const memberIds = batchClusters[topic];
                if (Array.isArray(memberIds) && memberIds.length > 1) {
                    const globalIds = memberIds.map(localId => batch[localId]?.tempId).filter(id => id !== undefined);
                    if (globalIds.length > 1) {
                         roughClusters[`topic_${clusterCounter++}`] = globalIds;
                    }
                }
            }
        } catch (error) {
            logger.warn(`广泛聚类批次处理失败: ${error.message}`);
        }
        progressBar.increment(batch.length);
    }
    
    const clusteredIds = new Set(_.flatten(Object.values(roughClusters)));
    articlesWithTempId.forEach(article => {
        if (!clusteredIds.has(article.tempId)) {
            roughClusters[`topic_${clusterCounter++}`] = [article.tempId];
        }
    });

    progressBar.stop();
    console.log(chalk.green(`初步聚类完成，形成 ${Object.keys(roughClusters).length} 个粗略议题簇。`));
    

    // --- 阶段二: 簇内验证与拆分 (已更新为逐一验证) ---
    console.log(chalk.cyan.bold('\n--- 阶段 2/3: 逐一验证与精确拆分 ---'));
    progressBar.start(Object.keys(roughClusters).length, 0, { status: "验证簇的内部一致性..." });

    let refinedClusters = [];
    const allClusterTasks = Object.values(roughClusters).map(memberIds => limit(async () => {
        try {
            const memberArticles = memberIds.map(id => articleMap[id]);
            if (memberArticles.length <= 1) {
                refinedClusters.push(memberArticles);
                progressBar.increment();
                return;
            }

            // a. 为当前簇生成核心主题
            const titles = memberArticles.map(m => m.title);
            const themePrompt = CONFIG.prompts.generateClusterTheme(titles);
            const coreTheme = await callLLM([{ role: 'system', content: themePrompt.system }, { role: 'user', content: themePrompt.user }], 0.0);

            // b. (核心修改) 逐一验证每个成员是否符合核心主题
            const consistentMembers = [];
            const verificationPromises = memberArticles.map(async (article) => {
                const { system, user } = CONFIG.prompts.verifySingleArticleConsistency(coreTheme, article.title);
                const result = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.0);
                return { article, isConsistent: result.toLowerCase().includes('yes') };
            });
            const verificationResults = await Promise.all(verificationPromises);

            // c. 执行拆分
            verificationResults.forEach(({ article, isConsistent }) => {
                if (isConsistent) {
                    consistentMembers.push(article);
                } else {
                    refinedClusters.push([article]); // 被踢出的文章成为新的独立簇
                    logger.debug(`拆分: "${article.title}" 因与主题 "${coreTheme}" 不符而被移出。`);
                }
            });

            if (consistentMembers.length > 0) {
                refinedClusters.push(consistentMembers);
            }
        } catch (error) {
            logger.warn(`簇验证和拆分失败: ${error.message}`);
            const memberArticles = memberIds.map(id => articleMap[id]);
            memberArticles.forEach(article => refinedClusters.push([article]));
        } finally {
            progressBar.increment();
        }
    }));
    
    await Promise.all(allClusterTasks);
    progressBar.stop();
    console.log(chalk.green(`验证拆分完成，议题数量调整为 ${refinedClusters.length} 个。`));


    // --- 阶段三: 收尾与格式化 ---
    console.log(chalk.green.bold('\n--- 阶段 3/3: 格式化最终议题 ---'));
    
    const uniqueContenders = refinedClusters.map(members => {
        const representative = _.orderBy(members, ['score'], ['desc'])[0];
        return {
            ...representative,
            clusterSize: members.length,
            clusterUrls: members.map(m => m.url),
            clusterTitles: members.map(m => m.title),
        };
    });

    logger.info(`三阶段聚类完成，从 ${articles.length} 篇文章中识别出 ${uniqueContenders.length} 个高度相关的独立新闻议题。`);
    
    return _.orderBy(uniqueContenders, ['score'], ['desc']);
}