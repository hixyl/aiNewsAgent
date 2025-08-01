// modules/grouper.js

import _ from 'lodash';
import chalk from 'chalk';
import pLimit from 'p-limit';
import CONFIG from '../config.js';
import logger from '../utils/logger.js';
import { callLLM } from '../services/network.js';

/**
 * 解析LLM返回的聚类结果JSON。
 */
function robustParseGroupingResponse(responseText, candidates) {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`聚类响应中未找到有效的JSON对象。收到: "${responseText}"`);
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Object.keys(parsed).length !== candidates.length) {
            logger.warn('LLM返回的聚类结果数量与候选文章数量不匹配。');
        }
        return parsed;
    } catch (error) {
        throw new Error(`聚类响应JSON解析失败: ${error.message}`);
    }
}

/**
 * 验证簇内文章的一致性，并返回不一致的文章。
 */
async function verifyCluster(cluster) {
    if (cluster.length <= 1) {
        return { consistent: cluster, outliers: [] };
    }

    const titles = cluster.map(a => a.title);

    try {
        const { system: themeSystem, user: themeUser } = CONFIG.prompts.generateClusterTheme(titles);
        const theme = await callLLM([{ role: 'system', content: themeSystem }, { role: 'user', content: themeUser }], 0.2);
        
        const { system: verifySystem, user: verifyUser } = CONFIG.prompts.verifyClusterConsistency(theme, titles);
        const response = await callLLM([{ role: 'system', content: verifySystem }, { role: 'user', content: verifyUser }], 0.1);

        if (response.toLowerCase().trim() === 'none') {
            return { consistent: cluster, outliers: [] };
        }

        const outlierIndices = response.split(',')
            .map(n => parseInt(n.trim(), 10) - 1)
            .filter(n => !isNaN(n) && n >= 0 && n < cluster.length);
        
        if (outlierIndices.length === 0) {
            return { consistent: cluster, outliers: [] };
        }

        const consistent = [];
        const outliers = [];
        cluster.forEach((article, index) => {
            if (outlierIndices.includes(index)) {
                outliers.push(article);
            } else {
                consistent.push(article);
            }
        });

        if (outliers.length > 0) {
            logger.info(`在议题 "${theme}" 的验证中，发现并剔除了 ${outliers.length} 个异常标题。`);
        }
        
        return { consistent: consistent.length > 0 ? consistent : [], outliers };

    } catch (error) {
        logger.warn(`簇验证过程失败: ${error.message}。该簇将不进行拆分。`, { titles });
        return { consistent: cluster, outliers: [] };
    }
}

/**
 * (新) 核心的、可重用的聚类与验证周期函数。
 * @param {Array<object>} articlesToProcess - 待处理的文章列表。
 * @param {import('cli-progress').SingleBar} progressBar - 进度条实例。
 * @param {number} cycleNum - 当前的迭代轮次。
 * @returns {Promise<{finalizedClusters: Array<Array<object>>, remainingOutliers: Array<object>}>}
 */
async function runClusteringCycle(articlesToProcess, progressBar, cycleNum) {
    const { groupingBatchSize, qualificationConcurrency } = CONFIG.ranking;
    
    // --- 阶段一: 快速语义初筛 ---
    let remainingToBatch = [...articlesToProcess];
    let initialClusters = [];

    progressBar.update(0, { status: `第${cycleNum}轮聚类: 初筛中...` });
    
    while (remainingToBatch.length > 0) {
        const batch = remainingToBatch.splice(0, groupingBatchSize);
        let representatives = initialClusters.map(c => _.orderBy(c, ['score'], ['desc'])[0]);

        if (representatives.length === 0) {
            if (batch.length > 0) {
                initialClusters.push([batch.shift()]);
            }
            if (batch.length === 0) continue;
            representatives = initialClusters.map(c => _.orderBy(c, ['score'], ['desc'])[0]);
        }

        try {
            const { system, user } = CONFIG.prompts.groupArticlesBySimilarity(representatives, batch);
            const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.1, CONFIG.llm.longRequestTimeout);
            const groupingResult = robustParseGroupingResponse(responseText, batch);
            
            Object.entries(groupingResult).forEach(([candidateId, clusterIndex]) => {
                const article = batch[parseInt(candidateId.replace('A', ''), 10)];
                if (!article) return;
                const targetIndex = clusterIndex - 1;
                if (clusterIndex > 0 && initialClusters[targetIndex]) {
                    initialClusters[targetIndex].push(article);
                } else {
                    initialClusters.push([article]);
                }
            });
        } catch (error) {
            logger.error(`第${cycleNum}轮聚类批处理失败: ${error.message}. 该批次文章将各自成为独立议题。`);
            batch.forEach(article => initialClusters.push([article]));
        }
    }
    logger.info(`第${cycleNum}轮初筛完成，形成 ${initialClusters.length} 个初步议题。`);

    // --- 阶段二: 主题生成与一致性验证 ---
    progressBar.setTotal(initialClusters.length);
    progressBar.update(0, { status: `第${cycleNum}轮聚类: 验证中...` });
    
    const finalizedClusters = [];
    let remainingOutliers = [];
    const limit = pLimit(qualificationConcurrency);

    const verificationPromises = initialClusters.map(cluster => limit(async () => {
        const { consistent, outliers } = await verifyCluster(cluster);
        if (consistent.length > 0) {
            finalizedClusters.push(consistent);
        }
        if (outliers.length > 0) {
            remainingOutliers.push(...outliers);
        }
        progressBar.increment();
    }));
    await Promise.all(verificationPromises);
    
    logger.info(`第${cycleNum}轮验证完成，确认了 ${finalizedClusters.length} 个纯净议题，产生了 ${remainingOutliers.length} 个待处理的异常文章。`);

    return { finalizedClusters, remainingOutliers };
}


/**
 * (已重构) 使用迭代式方法对文章进行语义聚类和去重。
 * 多次运行“初筛+验证”周期，直到所有异常文章都被妥善处理。
 * @param {Array<object>} articles - 候选文章列表。
 * @param {import('cli-progress').SingleBar} progressBar - 进度条实例。
 * @returns {Promise<Array<object>>} - 经过完整迭代和验证后的最终议题列表。
 */
export async function groupAndDeduplicateArticles(articles, progressBar) {
    if (articles.length === 0) return [];
    
    let articlesToProcess = [...articles];
    let allFinalizedClusters = [];
    let cycleNum = 1;
    const MAX_CYCLES = 5; // 设置最大循环次数，防止意外的无限循环

    console.log(chalk.cyan('\n启动迭代式语义聚类流程...'));
    
    while (articlesToProcess.length > 0 && cycleNum <= MAX_CYCLES) {
        progressBar.start(articlesToProcess.length, 0, {});
        console.log(chalk.cyan.bold(`\n--- 开始第 ${cycleNum} 轮聚类 (处理 ${articlesToProcess.length} 篇文章) ---`));

        const { finalizedClusters, remainingOutliers } = await runClusteringCycle(articlesToProcess, progressBar, cycleNum);

        allFinalizedClusters.push(...finalizedClusters);
        articlesToProcess = remainingOutliers; // 为下一轮准备数据
        cycleNum++;

        progressBar.stop();
        if (articlesToProcess.length > 0) {
             console.log(chalk.yellow(`本轮产生 ${articlesToProcess.length} 篇异常文章，将进入下一轮聚类处理。`));
        }
    }
    
    if (cycleNum > MAX_CYCLES) {
        logger.warn(`聚类达到最大迭代次数 ${MAX_CYCLES}，仍有 ${articlesToProcess.length} 篇文章未完全聚类，将它们各自视为独立议题。`);
        articlesToProcess.forEach(article => allFinalizedClusters.push([article]));
    }

    console.log(chalk.green.bold('\n✅ 迭代式聚类完成!'));
    logger.info(`迭代式聚类完成，共形成 ${allFinalizedClusters.length} 个最终议题。`);

    // --- 收尾: 格式化输出 ---
    const uniqueContenders = allFinalizedClusters.map(group => {
        const representative = _.orderBy(group, ['score'], ['desc'])[0];
        
        const finalRepresentative = {
            ...representative,
            clusterUrls: group.map(a => a.url),
            clusterTitles: group.map(a => a.title),
        };

        if (group.length > 1) {
            const groupTitles = group.map(a => `  - "${a.title}" (得分: ${a.score})`).join('\n');
            logger.debug(`合并了 ${group.length} 篇相似文章，选出代表: "${representative.title}"。\n该组包含:\n${groupTitles}`);
        }
        
        return finalRepresentative;
    });

    return _.orderBy(uniqueContenders, ['score'], ['desc']);
}