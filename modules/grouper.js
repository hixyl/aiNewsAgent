// modules/grouper.js

import pLimit from 'p-limit';
import _ from 'lodash';
import chalk from 'chalk';
import CONFIG from '../config.js';
import logger from '../utils/logger.js';
import { callLLM } from '../services/network.js';

/**
 * 从单个标题中提取关键词。
 * @param {string} title - 文章标题。
 * @returns {Promise<string[]>} - 小写关键词数组。
 */
async function getKeywordsForTitle(title) {
    const { system, user } = CONFIG.prompts.extractKeywordsFromTitle(title);
    const response = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.1);
    
    // LLM响应应该是一个用逗号分隔的关键词列表
    // 进行清洗，去除空字符串，并转换为小写
    return response.split(',')
        .map(k => k.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * (已修改) 对文章进行聚类和去重。
 * 不再丢弃同组文章，而是将整个组的信息附加到得分最高的代表文章上。
 * @param {Array<object>} articles - 候选文章列表。
 * @param {import('cli-progress').SingleBar} progressBar - 进度条实例。
 * @returns {Promise<Array<object>>} - 去重后的文章列表，其中每个文章对象都可能包含一个文章簇的信息。
 */
export async function groupAndDeduplicateArticles(articles, progressBar) {
    if (articles.length === 0) {
        return [];
    }
    
    progressBar.start(articles.length, 0, { status: "提取标题关键词..." });

    // 步骤 1: 并发地为所有文章提取关键词
    const limit = pLimit(CONFIG.ranking.qualificationConcurrency); // 复用资格赛的并发设置
    const articlesWithKeywords = [];

    const keywordPromises = articles.map(article => limit(async () => {
        try {
            const keywords = await getKeywordsForTitle(article.title);
            articlesWithKeywords.push({ ...article, keywords });
        } catch (error) {
            logger.warn(`未能从标题提取关键词: "${article.title}"`, { error: error.message });
            // 即使失败，也加入列表，确保文章不丢失
            articlesWithKeywords.push({ ...article, keywords: [] });
        } finally {
            progressBar.increment();
        }
    }));
    await Promise.all(keywordPromises);
    progressBar.stop();

    // 步骤 2: 基于共享的关键词对文章进行分组
    console.log(chalk.cyan('\n正在进行相似文章聚类...'));
    const groups = [];
    let remainingArticles = [...articlesWithKeywords];

    while (remainingArticles.length > 0) {
        const seedArticle = remainingArticles.shift();
        
        if (!seedArticle.keywords || seedArticle.keywords.length === 0) {
            groups.push([seedArticle]);
            continue;
        }

        const currentGroup = [seedArticle];
        const seedKeywords = new Set(seedArticle.keywords);

        for (let i = remainingArticles.length - 1; i >= 0; i--) {
            const targetArticle = remainingArticles[i];
            const hasSharedKeyword = targetArticle.keywords.some(kw => seedKeywords.has(kw));

            if (hasSharedKeyword) {
                currentGroup.push(targetArticle);
                remainingArticles.splice(i, 1);
            }
        }
        groups.push(currentGroup);
    }
    
    logger.info(`已将 ${articles.length} 篇文章聚类成 ${groups.length} 个独立议题。`);
    console.log(chalk.green(`聚类分析完成，共形成 ${groups.length} 个独立新闻议题。`));

    // 步骤 3: 从每个组中选出代表，并附加整个组的信息
    const uniqueContenders = groups.map(group => {
        const representative = _.orderBy(group, ['score'], ['desc'])[0];
        
        // **核心修改**：将组内所有文章的URL和标题附加到代表文章上
        const finalRepresentative = {
            ..._.omit(representative, 'keywords'), // 从最终对象中移除临时的 keywords 属性
            clusterUrls: group.map(a => a.url),
            clusterTitles: group.map(a => a.title),
        };

        if (group.length > 1) {
            const groupTitles = group.map(a => `  - "${a.title}" (得分: ${a.score})`).join('\n');
            logger.debug(`合并了 ${group.length} 篇相似文章，选出代表: "${representative.title}"。\n该组包含:\n${groupTitles}`);
        }
        
        return finalRepresentative;
    });

    // 按资格赛分数对最终选出的代表们进行一次排序
    return _.orderBy(uniqueContenders, ['score'], ['desc']);
}