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
            // 尝试修复JSON字符串中可能存在的尾随逗号问题
            const fixedJson = jsonMatch[0].replace(/,\s*([\}\]])/g, '$1');
            return JSON.parse(fixedJson);
        } catch (finalError) {
             throw new Error(`JSON解析失败: ${finalError.message}. Raw: ${jsonMatch[0]}`);
        }
    }
}

/**
 * (已重构) 使用基于图论的全局聚类算法，确保聚类的全局一致性。
 * @param {Array<object>} articles - 候选文章列表。
 * @param {import('cli-progress').SingleBar} progressBar - 进度条实例。
 * @returns {Promise<Array<object>>} - 经过聚类和去重后的最终议题列表。
 */
export async function groupAndDeduplicateArticles(articles, progressBar) {
    if (articles.length < 2) return articles;

    console.log(chalk.cyan.bold('\n启动基于全局图的聚类流程 (发现关系 -> 构建图 -> 查找簇)...'));
    
    // (已修正) 从新的、正确的配置路径中读取参数。
    // 旧的 qualificationConcurrency 不再存在于 CONFIG.ranking 的顶层。
    const { groupingBatchSize, groupingMaxRetries, groupingRetryDelay } = CONFIG.ranking;
    const { concurrency } = CONFIG.ranking.qualification; // 正确的并发数读取路径
    const limit = pLimit(concurrency); // 使用正确的并发数值

    const articlesWithId = articles.map((article, index) => ({ ...article, id: index }));
    const articleMap = _.keyBy(articlesWithId, 'id');
    
    // --- 阶段一: 分批寻找“原子关系”，并全局汇总 ---
    console.log(chalk.cyan.bold('\n--- 阶段 1/3: 发现全局相似关系 ---'));
    let allSimilarPairs = [];

    // 1a. 分批处理，寻找“批次内”的相似关系
    progressBar.start(articles.length, 0, { status: "步骤1a: 查找批次内的相似关系..." });
    const batches = _.chunk(articlesWithId, groupingBatchSize);
    for (const batch of batches) {
        // **(核心修改)** 在此处增加重试逻辑
        let success = false;
        for (let attempt = 1; attempt <= groupingMaxRetries; attempt++) {
            try {
                const { system, user } = CONFIG.prompts.findSimilarPairs(batch);
                const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.0);
                const clustersInBatch = robustJsonParse(responseText);

                if (Array.isArray(clustersInBatch)) {
                    for (const cluster of clustersInBatch) {
                        if (Array.isArray(cluster) && cluster.length > 1) {
                            for (let i = 0; i < cluster.length; i++) {
                                for (let j = i + 1; j < cluster.length; j++) {
                                    const localIndex1 = cluster[i];
                                    const localIndex2 = cluster[j];
                                    if (batch[localIndex1] && batch[localIndex2]) {
                                        const globalId1 = batch[localIndex1].id;
                                        const globalId2 = batch[localIndex2].id;
                                        allSimilarPairs.push([globalId1, globalId2]);
                                    }
                                }
                            }
                        }
                    }
                }
                success = true; // 成功执行，跳出重试循环
                break;
            } catch (error) {
                logger.warn(`聚类批次处理失败 (尝试 ${attempt}/${groupingMaxRetries}): ${error.message}`);
                if (attempt === groupingMaxRetries) {
                    logger.error(`批次处理在所有重试后仍然失败，跳过此批次。`, { batchTitles: batch.map(a => a.title) });
                } else {
                    // 等待指数退避时间后重试
                    const delay = groupingRetryDelay * Math.pow(2, attempt - 1);
                    await new Promise(res => setTimeout(res, delay));
                }
            }
        }
        progressBar.increment(batch.length);
    }
    progressBar.stop();
    logger.info(`完成批次内关系查找，初步发现 ${allSimilarPairs.length} 对相似关系。`);

    // 1b. 通过“代表交叉对比”，补充“跨批次”的相似关系
    console.log(chalk.cyan('步骤1b: 通过代表交叉对比，查找跨批次的相似关系...'));
    const initialClusters = findConnectedComponents(articles.length, allSimilarPairs);
    const representatives = initialClusters.map(clusterIds => {
        const clusterArticles = clusterIds.map(id => articleMap[id]);
        return _.orderBy(clusterArticles, ['score'], ['desc'])[0];
    }).filter(Boolean);

    if (representatives.length > 1) {
        const repBatches = _.chunk(representatives, groupingBatchSize);
        progressBar.start(representatives.length, 0, { status: "交叉对比代表文章..." });

        for (const repBatch of repBatches) {
             // **(核心修改)** 在此处也增加同样的重试逻辑
            let success = false;
            for (let attempt = 1; attempt <= groupingMaxRetries; attempt++) {
                try {
                    const { system, user } = CONFIG.prompts.findSimilarPairs(repBatch);
                    const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.0);
                    const similarRepClusters = robustJsonParse(responseText);

                    if (Array.isArray(similarRepClusters)) {
                        for (const cluster of similarRepClusters) {
                            if (Array.isArray(cluster) && cluster.length > 1) {
                                for (let i = 0; i < cluster.length; i++) {
                                    for (let j = i + 1; j < cluster.length; j++) {
                                        const rep1 = repBatch[cluster[i]];
                                        const rep2 = repBatch[cluster[j]];
                                        if(rep1 && rep2) {
                                            allSimilarPairs.push([rep1.id, rep2.id]);
                                            logger.debug(`发现跨簇关系: "${rep1.title}" <-> "${rep2.title}"`);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    success = true; // 成功执行，跳出重试循环
                    break;
                } catch (error) {
                    logger.warn(`代表交叉对比失败 (尝试 ${attempt}/${groupingMaxRetries}): ${error.message}`);
                    if (attempt === groupingMaxRetries) {
                         logger.error(`代表交叉对比在所有重试后仍然失败，跳过此批次。`, { batchTitles: repBatch.map(a => a.title) });
                    } else {
                        const delay = groupingRetryDelay * Math.pow(2, attempt - 1);
                        await new Promise(res => setTimeout(res, delay));
                    }
                }
            }
            progressBar.increment(repBatch.length);
        }
        progressBar.stop();
    }
    logger.info(`完成代表交叉对比，最终共发现 ${allSimilarPairs.length} 对全局相似关系。`);


    // --- 阶段二: 在“全局图”上执行算法，查找最终簇 ---
    console.log(chalk.cyan.bold('\n--- 阶段 2/3: 构建全局图并查找最终议题簇 ---'));
    const finalClusters = findConnectedComponents(articles.length, allSimilarPairs);


    // --- 阶段三: 收尾与格式化 ---
    console.log(chalk.cyan.bold('\n--- 阶段 3/3: 格式化最终议题 ---'));
    const uniqueContenders = finalClusters.map(clusterMemberIds => {
        const members = clusterMemberIds.map(id => articleMap[id]);
        const representative = _.orderBy(members, ['score'], ['desc'])[0];
        return {
            ...representative,
            clusterSize: members.length,
            clusterUrls: members.map(m => m.url),
            clusterTitles: members.map(m => m.title),
        };
    });

    logger.info(`全局图聚类完成，从 ${articles.length} 篇文章中识别出 ${uniqueContenders.length} 个独立新闻议题。`);
    
    return _.orderBy(uniqueContenders, ['score'], ['desc']);
}


/**
 * 使用图的广度优先搜索（BFS）查找所有连通分量（即簇）。
 * @param {number} numNodes - 图中的节点总数（文章总数）
 * @param {Array<Array<number>>} edges - 边的列表，每条边是 [node1, node2]
 * @returns {Array<Array<number>>} - 返回一个数组，每个子数组是一个连通分量（簇）的节点ID列表
 */
function findConnectedComponents(numNodes, edges) {
    if (numNodes === 0) return [];
    
    const adj = Array.from({ length: numNodes }, () => []);
    for (const [u, v] of edges) {
        if (u < numNodes && v < numNodes) {
            adj[u].push(v);
            adj[v].push(u);
        }
    }

    const clusters = [];
    const visited = new Array(numNodes).fill(false);

    for (let i = 0; i < numNodes; i++) {
        if (!visited[i]) {
            const currentCluster = [];
            const queue = [i];
            visited[i] = true;

            while (queue.length > 0) {
                const u = queue.shift();
                currentCluster.push(u);

                if (adj[u]) {
                    for (const v of adj[u]) {
                        if (!visited[v]) {
                            visited[v] = true;
                            queue.push(v);
                        }
                    }
                }
            }
            clusters.push(currentCluster);
        }
    }

    return clusters;
}