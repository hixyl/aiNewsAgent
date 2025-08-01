// modules/crawler.js

import chalk from 'chalk';
import pLimit from 'p-limit';
import _ from 'lodash';
import CONFIG from '../config.js';
import logger from '../utils/logger.js';
import { fetchAndParsePage, callLLM } from '../services/network.js';

/**
 * (已重构) 通过多轮瑞士制对发现的栏目链接进行排名，选出最重要的栏目。
 * @param {Array<object>} categories - 栏目链接对象列表
 * @returns {Promise<Array<object>>} - 按重要性得分排序后的栏目列表
 */
async function rankAndSelectCategories(categories) {
    const { categoryRankingRounds, categoryRankingGroupSize, categoryRankingPoints } = CONFIG.crawling;
    // 复用资格赛的并发设置
    const limit = pLimit(CONFIG.ranking.qualificationConcurrency);
    let categoriesWithScores = categories.map(cat => ({ ...cat, score: 0 }));

    logger.info(`开始对 ${categories.length} 个栏目进行 ${categoryRankingRounds} 轮瑞士制排名...`);

    for (let round = 1; round <= categoryRankingRounds; round++) {
        // 第一轮随机分组，后续轮次按分数高低分组
        const categoriesToRank = round === 1 
            ? _.shuffle(categoriesWithScores) 
            : _.orderBy(categoriesWithScores, ['score'], ['desc']);

        const groups = _.chunk(categoriesToRank, categoryRankingGroupSize);

        const rankingPromises = groups.map(group => limit(async () => {
            if (group.length < 2) { // 如果小组内少于2个，则不进行比较
                if (group.length === 1) {
                    // 对于只有一个成员的小组，可以给予一个基础的“参与分”
                    const targetCategory = categoriesWithScores.find(c => c.url === group[0].url);
                    if (targetCategory && categoryRankingPoints.length > 1) {
                        targetCategory.score += categoryRankingPoints[1]; // 比如给予第二名的分数
                    }
                }
                return;
            }
            try {
                const groupTitlesAndLinks = group.map(cat => ({title: cat.title, link: cat.url}));
                const { system, user } = CONFIG.prompts.rankCategories(groupTitlesAndLinks, CONFIG.taskDescription);
                const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.2);

                const rankedIndices = responseText.split(',').map(n => parseInt(n.trim(), 10) - 1).filter(n => !isNaN(n));

                // 确保LLM返回的索引数量和小组大小匹配，如果不匹配则跳过，防止出错
                if (rankedIndices.length !== group.length) {
                    logger.warn('栏目排名返回的索引数量与小组规模不匹配，跳过此小组。', {
                        expected: group.length,
                        received: rankedIndices.length,
                        response: responseText,
                    });
                    return;
                }

                rankedIndices.forEach((originalIndex, rank) => {
                    const categoryInGroup = group[originalIndex];
                    if (categoryInGroup && categoryRankingPoints[rank] !== undefined) {
                        // 找到主列表中的对象并更新分数
                        const targetCategory = categoriesWithScores.find(c => c.url === categoryInGroup.url);
                        if (targetCategory) {
                            targetCategory.score += categoryRankingPoints[rank];
                        }
                    }
                });
            } catch (error) {
                logger.warn(`栏目小组排名失败 (第 ${round} 轮)`, { error: error.message });
            }
        }));

        await Promise.all(rankingPromises);
        logger.info(`栏目排名第 ${round}/${categoryRankingRounds} 轮完成。`);
    }
    logger.info(`所有栏目排名轮次完成。`);
    return _.orderBy(categoriesWithScores, ['score'], ['desc']);
}


/**
 * 发现文章链接并通过多轮瑞士制资格赛筛选出候选者。
 * @param {import('ora').Ora} spinner - Ora微调器实例，用于显示状态
 * @param {import('cli-progress').SingleBar} progressBar - 进度条实例
 * @returns {Promise<Array<object>>} - 通过资格赛的候选文章元数据列表
 */
export async function discoverAndRankContenders(spinner, progressBar) {
    let pagesToVisit = [{ url: CONFIG.startUrl, depth: 1 }];
    const visitedUrls = new Set([CONFIG.startUrl]);
    const allFoundLinks = new Map();

    spinner.start(chalk.cyan('开始抓取网站链接...'));

    let pagesExplored = 0;
    while (pagesToVisit.length > 0) {
        const currentPage = pagesToVisit.shift();
        if (currentPage.depth > CONFIG.crawling.maxDepth) continue;

        pagesExplored++;
        spinner.text = `[${pagesExplored}] [深度 ${currentPage.depth}] 探索页面: ${currentPage.url}`;

        try {
            const $ = await fetchAndParsePage(currentPage.url);
            const baseUrl = currentPage.url;
            const newCategoryPages = [];
            const linkElements = $('a').toArray();

            for (const el of linkElements) {
                const linkUrl = $(el).attr('href');
                const linkTitle = $(el).text().trim().replace(/\s+/g, ' ');

                if (linkUrl && linkTitle && linkTitle.length > 4 && !CONFIG.crawling.uselessTitleKeywords.some(kw => linkTitle.includes(kw))) {
                    try {
                        const absoluteUrl = new URL(linkUrl, baseUrl).href;
                        const urlObject = new URL(absoluteUrl);
                        const canonicalUrl = `${urlObject.protocol}//${urlObject.hostname}${urlObject.pathname}`;

                        if ((urlObject.protocol === 'http:' || urlObject.protocol === 'https:') &&
                            !urlObject.pathname.match(/\.(pdf|zip|jpg|png|gif|css|js|mp3|mp4|xml|ico)$/i) &&
                            !visitedUrls.has(canonicalUrl)) {
                            
                            visitedUrls.add(canonicalUrl);
                            const { system, user } = CONFIG.prompts.classifyLinkType(linkTitle, linkUrl);
                            const type = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.1);

                            if (type.includes('article')) {
                                allFoundLinks.set(canonicalUrl, { url: canonicalUrl, title: linkTitle, type: 'article' });
                            } else if (type.includes('category') && currentPage.depth < CONFIG.crawling.maxDepth) {
                                // 使用去重后的栏目URL作为唯一标识
                                const existingCategory = newCategoryPages.find(p => p.url === canonicalUrl);
                                if (!existingCategory) {
                                    newCategoryPages.push({ url: canonicalUrl, title: linkTitle, type: 'category' });
                                }
                            }
                        }
                    } catch (e) { /* 忽略无效URL */ }
                }
            }

            // **核心修改**: 对发现的新栏目进行排名，并选择最重要的进行下一步探索
            if (newCategoryPages.length > 0) {
                if (newCategoryPages.length > CONFIG.crawling.maxCategoriesToExplore) {
                    spinner.text = `[${pagesExplored}] [深度 ${currentPage.depth}] 发现 ${newCategoryPages.length} 个新栏目，正在进行重要性排名...`;
                    
                    const rankedCategories = await rankAndSelectCategories(newCategoryPages);
                    const topCategories = rankedCategories.slice(0, CONFIG.crawling.maxCategoriesToExplore);
                    
                    spinner.text = `[${pagesExplored}] [深度 ${currentPage.depth}] 排名完成，选出 ${topCategories.length} 个重要栏目继续探索。`;
                    logger.info(`在深度 ${currentPage.depth}，从 ${newCategoryPages.length} 个栏目中选出最重要的 ${topCategories.length} 个进行下一步探索。`);
                    
                    const pagesToAdd = topCategories.map(p => ({ url: p.url, depth: currentPage.depth + 1 }));
                    pagesToVisit.push(...pagesToAdd);
                } else {
                    // 如果发现的栏目数量不足配置的最大探索数，则全部加入
                    const pagesToAdd = newCategoryPages.map(p => ({ url: p.url, depth: currentPage.depth + 1 }));
                    pagesToVisit.push(...pagesToAdd);
                }
            }
        } catch (error) {
            spinner.warn(chalk.yellow(`页面探索失败 ${currentPage.url}: ${error.message}`));
            continue;
        }
    }

    spinner.succeed(chalk.green(`链接抓取完成! 共发现 ${allFoundLinks.size} 篇不重复的文章链接.`));

    let articleLinks = Array.from(allFoundLinks.values()).map(link => ({ ...link, score: 0 }));
    if (articleLinks.length === 0) return [];

    // --- 资格赛 (瑞士制) ---
    const { qualificationRounds, qualificationGroupSize, qualificationPoints, qualificationConcurrency } = CONFIG.ranking;
    const totalComparisons = qualificationRounds * Math.ceil(articleLinks.length / qualificationGroupSize);
    progressBar.start(totalComparisons, 0, { status: "资格赛 - 初始化..." });

    const limit = pLimit(qualificationConcurrency);

    for (let round = 1; round <= qualificationRounds; round++) {
        const articlesToRank = round === 1 
            ? _.shuffle(articleLinks) 
            : _.orderBy(articleLinks, ['score'], ['desc']);

        const groups = _.chunk(articlesToRank, qualificationGroupSize);

        const qualificationPromises = groups.map(group => limit(async () => {
            try {
                const groupTitles = group.map(link => link.title);
                const { system, user } = CONFIG.prompts.qualifyLinks(groupTitles, CONFIG.taskDescription);
                const responseText = await callLLM([{ role: 'system', content: system }, { role: 'user', content: user }], 0.2);

                const rankedIndices = responseText.split(',').map(n => parseInt(n.trim(), 10) - 1).filter(n => !isNaN(n));
                
                if (rankedIndices.length !== group.length) {
                    logger.warn('文章资格赛排名返回的索引数量与小组规模不匹配，跳过此小组。', {
                        expected: group.length,
                        received: rankedIndices.length,
                        response: responseText,
                    });
                    return;
                }

                rankedIndices.forEach((originalIndex, rank) => {
                    const articleInGroup = group[originalIndex];
                    if (articleInGroup && qualificationPoints[rank] !== undefined) {
                        const targetArticle = articleLinks.find(a => a.url === articleInGroup.url);
                        if (targetArticle) {
                            targetArticle.score += qualificationPoints[rank];
                        }
                    }
                });
            } catch (error) {
                logger.warn('资格赛小组排名失败', { error: error.message });
            } finally {
                progressBar.increment(1, { status: `第 ${round}/${qualificationRounds} 轮评估中...` });
            }
        }));
        await Promise.all(qualificationPromises);
    }

    progressBar.stop();
    
    const finalRankedLinks = _.orderBy(articleLinks, ['score'], ['desc']);
    const contenders = finalRankedLinks.slice(0, CONFIG.ranking.contendersToRank);
    
    logger.info(`资格赛完成，根据 ${qualificationRounds} 轮积分，选出 ${contenders.length} 位决赛选手。`);

    if (contenders.length > 0) {
        console.log(chalk.cyan.bold(`\n✅ 资格赛完成! ${contenders.length} 篇文章晋级决赛圈.`));
    }
    
    return contenders;
}