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
 * (已重构) 使用基于图论的全局聚类算法，确保聚类的全局一致性。
 * @param {Array<object>} articles - 候选文章列表。
 * @param {import('cli-progress').SingleBar} progressBar - 进度条实例。
 * @returns {Promise<Array<object>>} - 经过聚类和去重后的最终议题列表。
 */
export async function groupAndDeduplicateArticles(articles, progressBar) {
    if (articles.length < 2) return articles;

    console.log(chalk.cyan.bold('\n启动基于全局图的聚类流程 (发现关系 -> 构建图 -> 查找簇)...'));
    const { qualificationConcurrency, groupingBatchSize } = CONFIG.ranking;
    const limit = pLimit(qualificationConcurrency);

    const articlesWithId = articles.map((article, index) => ({ ...article, id: index }));
    const articleMap = _.keyBy(articlesWithId, 'id');
    
    // --- 阶段一: 分批寻找“原子关系”，并全局汇总 ---
    console.log(chalk.cyan.bold('\n--- 阶段 1/3: 发现全局相似关系 ---'));
    let allSimilarPairs = [];

    // 1a. 分批处理，寻找“批次内”的相似关系
    progressBar.start(articles.length, 0, { status: "步骤1a: 查找批次内的相似关系..." });
    const batches = _.chunk(articlesWithId, groupingBatchSize);
    for (const batch of batches) {
        try {
            const { system, user } = CONFIG.prompts.findSimilarPairs(batch);
            const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.0);
            const similarPairsInBatch = robustJsonParse(responseText);

            if (Array.isArray(similarPairsInBatch)) {
                for (const pair of similarPairsInBatch) {
                    if (pair.length === 2 && batch[pair[0]] && batch[pair[1]]) {
                        // 将批次内的局部索引转换为全局ID
                        const globalId1 = batch[pair[0]].id;
                        const globalId2 = batch[pair[1]].id;
                        allSimilarPairs.push([globalId1, globalId2]);
                    }
                }
            }
        } catch (error) {
            logger.warn(`批次内关系查找失败: ${error.message}`);
        }
        progressBar.increment(batch.length);
    }
    progressBar.stop();
    logger.info(`完成批次内关系查找，发现 ${allSimilarPairs.length} 对相似关系。`);

    // 1b. 通过“代表交叉对比”，补充“跨批次”的相似关系
    console.log(chalk.cyan('步骤1b: 通过代表交叉对比，查找跨批次的相似关系...'));

    // 基于现有关系，进行初步聚合，形成“簇核”
    const initialClusters = findConnectedComponents(articles.length, allSimilarPairs);
    
    // 从每个“簇核”中选举代表（得分最高者）
    const representatives = initialClusters.map(clusterIds => {
        const clusterArticles = clusterIds.map(id => articleMap[id]);
        return _.orderBy(clusterArticles, ['score'], ['desc'])[0];
    }).filter(Boolean); // 过滤掉空簇

    if (representatives.length > 1) {
        const repBatches = _.chunk(representatives, groupingBatchSize);
        progressBar.start(representatives.length, 0, { status: "交叉对比代表文章..." });

        for (const repBatch of repBatches) {
             try {
                const { system, user } = CONFIG.prompts.findSimilarPairs(repBatch);
                const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.0);
                const similarRepPairs = robustJsonParse(responseText);

                if (Array.isArray(similarRepPairs)) {
                    for (const pair of similarRepPairs) {
                        if (pair.length === 2 && repBatch[pair[0]] && repBatch[pair[1]]) {
                            const rep1 = repBatch[pair[0]];
                            const rep2 = repBatch[pair[1]];
                            // 将代表之间的关系，添加回全局关系列表
                            allSimilarPairs.push([rep1.id, rep2.id]);
                            logger.debug(`发现跨簇关系: "${rep1.title}" <-> "${rep2.title}"`);
                        }
                    }
                }
            } catch (error) {
                logger.warn(`代表交叉对比失败: ${error.message}`);
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
        // 按资格赛分数选出代表
        const representative = _.orderBy(members, ['score'], ['desc'])[0];
        return {
            ...representative,
            clusterSize: members.length,
            clusterUrls: members.map(m => m.url),
            clusterTitles: members.map(m => m.title),
        };
    });

    logger.info(`全局图聚类完成，从 ${articles.length} 篇文章中识别出 ${uniqueContenders.length} 个独立新闻议题。`);
    
    // 最后根据代表文章的资格赛分数进行排序
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
    
    // 1. 构建邻接表来表示图
    const adj = Array.from({ length: numNodes }, () => []);
    for (const [u, v] of edges) {
        adj[u].push(v);
        adj[v].push(u);
    }

    const clusters = [];
    const visited = new Array(numNodes).fill(false);

    // 2. 遍历所有节点
    for (let i = 0; i < numNodes; i++) {
        if (!visited[i]) {
            // 3. 如果节点未被访问，从它开始进行BFS，找到一个完整的连通分量
            const currentCluster = [];
            const queue = [i];
            visited[i] = true;

            while (queue.length > 0) {
                const u = queue.shift();
                currentCluster.push(u);

                for (const v of adj[u]) {
                    if (!visited[v]) {
                        visited[v] = true;
                        queue.push(v);
                    }
                }
            }
            clusters.push(currentCluster);
        }
    }

    return clusters;
}