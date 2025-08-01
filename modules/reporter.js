// modules/reporter.js

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import CONFIG from '../config.js';
import logger from '../utils/logger.js';
import { getCategoryEmoji } from '../utils/helpers.js';
import { callLLM } from '../services/network.js';
import _ from 'lodash'; 

/**
 * (已修改) 根据处理好的文章数据，生成最终的Markdown简报。
 * 能正确处理包含文章簇的议题。
 * @param {Array<object>} articles - 已处理并包含所有元数据的文章/议题列表
 * @param {string} dailyOutputDir - 当日输出目录
 * @param {import('ora').Ora} spinner - Ora微调器实例
 * @returns {Promise<object|null>} - 包含报告路径的对象，或在无文章时返回null
 */
export async function generateFinalReport(articles, dailyOutputDir, spinner) {
    if (articles.length === 0) {
        logger.warn('未成功处理任何文章，无法生成简报。');
        console.log('\n' + chalk.red.bold('❌ 未成功处理任何文章，无法生成简报。'));
        return null;
    }

    const sortedArticles = _.orderBy(articles, ['tournamentScore'], ['desc']);
    logger.info(`已根据最终重要性得分对 ${articles.length} 篇成功处理的议题完成排序。`);

    spinner.start('AI正在撰写总编导语...');
    const today = new Date().toISOString().slice(0, 10);
    const conciseSummariesText = sortedArticles
        .map((a, i) => `${i + 1}. 【${a.category}】${a.title}: ${a.conciseSummary}`)
        .join('\n');

    const { system, user } = CONFIG.prompts.generateEditorIntro(conciseSummariesText);
    let editorIntroduction = "今日要闻看点：";
    try {
        editorIntroduction = await callLLM(
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            0.6,
            CONFIG.llm.longRequestTimeout
        );
    } catch (error) {
        spinner.warn(chalk.yellow("总编导语生成失败，将使用默认导语。"));
        logger.error("总编导语生成失败", { error });
    }
    spinner.succeed(chalk.green.bold('总编导语已生成!'));

    let finalMarkdown = `# 每日新闻简报 (${today})\n\n`;
    finalMarkdown += `> **总编导语**\n> ${editorIntroduction.replace(/\n/g, '\n> ')}\n\n---\n\n`;

    finalMarkdown += `### **目录 (Table of Contents)**\n`;
    sortedArticles.forEach((article, index) => {
        finalMarkdown += `${index + 1}. [${getCategoryEmoji(article.category)}【${article.category}】${article.title}](#${index + 1})\n`;
    });
    finalMarkdown += `\n---\n\n`;

    for (const [index, article] of sortedArticles.entries()) {
        finalMarkdown += `### <a id="${index + 1}"></a> ${index + 1}. ${getCategoryEmoji(article.category)}【${article.category}】${article.title}\n\n`;
        finalMarkdown += `* **一句话摘要**: ${article.conciseSummary}\n`;
        finalMarkdown += `* **重要性排名**: ${article.rank} (锦标赛得分: ${article.tournamentScore})\n`;
        if (article.keywords && article.keywords.length > 0) {
            finalMarkdown += `* **核心词**: ${article.keywords.join('、')}\n\n`;
        } else {
            finalMarkdown += `\n`;
        }
        finalMarkdown += `#### **详细内容**\n${article.detailedSummary}\n\n`;

        // **核心修改**: 优雅地处理原文链接，区分单个文章和文章簇
        const isCluster = article.clusterUrls && article.clusterUrls.length > 1;
        if (isCluster) {
            finalMarkdown += `**相关原文链接**:\n`;
            finalMarkdown += article.clusterUrls.map((url, i) => `- [${article.clusterTitles[i]}](${url})`).join('\n') + '\n\n';
        } else {
            finalMarkdown += `[阅读原文](${article.url})\n\n`;
        }
        finalMarkdown += `---\n\n`;
    }

    const reportFileName = `News-Briefing-${today}.md`;
    const reportFilePath = path.join(dailyOutputDir, reportFileName);
    await fs.writeFile(reportFilePath, finalMarkdown);
    logger.info(`最终报告已生成: ${reportFilePath}`);

    return {
        reportFilePath,
        individualArticlesDir: path.join(dailyOutputDir, 'articles_markdown')
    };
}