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
        throw new Error(`JSON解析失败: ${error.message}. Raw: ${jsonMatch[0]}`);
    }
}

/**
 * (已重构) 使用更稳健的多阶段混合方法对文章进行语义聚类和去重。
 * @param {Array<object>} articles - 候选文章列表。
 * @param {import('cli-progress').SingleBar} progressBar - 进度条实例。
 * @returns {Promise<Array<object>>} - 经过聚类和去重后的最终议题列表。
 */
export async function groupAndDeduplicateArticles(articles, progressBar) {
    if (articles.length < 2) return articles;
    
    console.log(chalk.cyan('\n启动多阶段稳健聚类流程...'));
    
    const { groupingBatchSize, qualificationConcurrency, maxGroupingCycles } = CONFIG.ranking;
    const limit = pLimit(qualificationConcurrency);

    // --- 数据初始化，为每篇文章分配一个唯一的簇ID ---
    let articleClusters = articles.map((article, index) => ({
        ...article,
        clusterId: index,
        members: [article]
    }));
    
    // --- 阶段一: 高置信度配对合并 ---
    console.log(chalk.cyan.bold('\n--- 阶段 1/2: 高置信度配对合并 ---'));
    progressBar.start(articles.length, 0, { status: "查找相似配对..." });

    const batches = _.chunk(articleClusters, groupingBatchSize);
    for (const batch of batches) {
        try {
            const { system, user } = CONFIG.prompts.findSimilarPairs(batch);
            const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.0);
            const similarPairs = robustJsonParse(responseText);

            if (Array.isArray(similarPairs)) {
                for (const pair of similarPairs) {
                    if (pair.length === 2) {
                        const [idx1, idx2] = pair;
                        const article1 = batch[idx1];
                        const article2 = batch[idx2];
                        if (!article1 || !article2) continue;

                        // 合并簇：将得分较低的簇合并到得分较高的簇中
                        const cluster1 = articleClusters.find(c => c.clusterId === article1.clusterId);
                        const cluster2 = articleClusters.find(c => c.clusterId === article2.clusterId);

                        if (cluster1 && cluster2 && cluster1.clusterId !== cluster2.clusterId) {
                            const [absorber, absorbed] = cluster1.score >= cluster2.score ? [cluster1, cluster2] : [cluster2, cluster1];
                            
                            // 将被吸收簇的所有成员的clusterId更新为吸收者的ID
                            absorbed.members.forEach(member => {
                                const originalArticle = articleClusters.find(a => a.url === member.url);
                                if (originalArticle) originalArticle.clusterId = absorber.clusterId;
                            });
                            
                            logger.debug(`高置信度合并: "${absorbed.title}" 并入 "${absorber.title}"`);
                        }
                    }
                }
            }
        } catch (error) {
            logger.warn(`高置信度配对批次失败: ${error.message}`);
        }
        progressBar.increment(batch.length);
    }
    progressBar.stop();


    // --- 阶段二: 代表-候选人迭代聚类 ---
    console.log(chalk.cyan.bold('\n--- 阶段 2/2: 代表-候选人迭代聚类 ---'));
    
    for (let cycle = 1; cycle <= maxGroupingCycles; cycle++) {
        // 根据当前的clusterId重新生成簇
        const currentGroups = _.groupBy(articleClusters, 'clusterId');
        let clusters = Object.values(currentGroups).map(members => {
            const representative = _.orderBy(members, ['score'], ['desc'])[0];
            return { ...representative, members };
        });

        const representatives = clusters.filter(c => c.members.length > 1);
        let candidates = clusters.filter(c => c.members.length === 1);

        if (candidates.length === 0 || representatives.length === 0) {
            logger.info(`第 ${cycle} 轮迭代：无候选者或代表，聚类结束。`);
            break;
        }

        console.log(`\n第 ${cycle}/${maxGroupingCycles} 轮迭代: ${representatives.length}个代表簇 vs ${candidates.length}个候选文章`);
        progressBar.start(candidates.length, 0, { status: "匹配候选者..." });
        
        const candidateBatches = _.chunk(candidates, groupingBatchSize);
        let hasChanged = false;

        for (const candBatch of candidateBatches) {
             try {
                const { system, user } = CONFIG.prompts.groupAgainstRepresentatives(representatives, candBatch);
                const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.1, CONFIG.llm.longRequestTimeout);
                const groupingResult = robustJsonParse(responseText);

                for (const [candId, repId] of Object.entries(groupingResult)) {
                    if (repId !== 'new') {
                        const candIndex = parseInt(candId.replace('C_', ''), 10);
                        const repIndex = parseInt(repId.replace('R_', ''), 10);
                        
                        const candidate = candBatch[candIndex];
                        const representative = representatives[repIndex];

                        if (candidate && representative) {
                            const originalArticle = articleClusters.find(a => a.url === candidate.url);
                            if(originalArticle && originalArticle.clusterId !== representative.clusterId) {
                                originalArticle.clusterId = representative.clusterId;
                                hasChanged = true;
                                logger.debug(`迭代合并: "${candidate.title}" 并入 "${representative.title}"`);
                            }
                        }
                    }
                }
            } catch(error) {
                logger.warn(`代表-候选人聚类批次失败: ${error.message}`);
            }
            progressBar.increment(candBatch.length);
        }
        progressBar.stop();
        
        if (!hasChanged) {
            logger.info(`第 ${cycle} 轮迭代：簇成员无变化，聚类稳定，提前结束。`);
            break;
        }
    }


    // --- 收尾: 格式化输出 ---
    console.log(chalk.green.bold('\n✅ 聚类完成! 正在生成最终议题...'));
    const finalGroups = _.groupBy(articleClusters, 'clusterId');
    const uniqueContenders = Object.values(finalGroups).map(members => {
        const representative = _.orderBy(members, ['score'], ['desc'])[0];
        return {
            ...representative,
            clusterSize: members.length,
            clusterUrls: members.map(m => m.url),
            clusterTitles: members.map(m => m.title),
        };
    });

    logger.info(`稳健聚类完成，从 ${articles.length} 篇文章中识别出 ${uniqueContenders.length} 个独立新闻议题。`);
    
    // 最后根据代表文章的资格赛分数进行排序
    return _.orderBy(uniqueContenders, ['score'], ['desc']);
}