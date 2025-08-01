// index.js

import path from 'path';
import fs from 'fs/promises';
import chalk from 'chalk';
import ora from 'ora';
import cliProgress from 'cli-progress';
import boxen from 'boxen';

import CONFIG from './config.js';
import logger from './utils/logger.js';
import { gracefulShutdown } from './utils/helpers.js';
import { discoverAndRankContenders } from './modules/crawler.js';
import { groupAndDeduplicateArticles } from './modules/grouper.js';
import { runFinalTournament } from './modules/ranker.js';
// **变更**: 引入了新的处理函数
import { attemptToProcessArticle } from './modules/processor.js';
import { generateFinalReport } from './modules/reporter.js';


/**
 * @description 主执行函数
 */
async function main() {
    console.log(boxen(chalk.bold.cyan('AI新闻简报生成器 (模块化版)'), { padding: 1, margin: 1, borderStyle: 'double', borderColor: 'cyan' }));
    logger.info('--- 程序启动 ---');

    const today = new Date().toISOString().slice(0, 10);
    const domain = CONFIG.startUrl.split('://')[1]?.split('/')[0]
    const dailyOutputDir = path.join(CONFIG.outputBaseDir, `${today}_${domain}`);
    await fs.mkdir(dailyOutputDir, { recursive: true });

    // 初始化UI组件
    const spinner = ora({ text: '初始化...', spinner: 'dots' });
    const multiBar = new cliProgress.MultiBar({
        clearOnComplete: false,
        hideCursor: true,
        format: `{step} |${chalk.cyan('{bar}')}| {percentage}% | {value}/{total} | {status}`,
    }, cliProgress.Presets.shades_classic);

    let successfulArticleCount = 0;
    let articlesToProcessGoal = CONFIG.processing.maxArticlesToProcess;


    try {
        // --- 步骤 1: 抓取与资格赛 ---
        console.log(boxen(chalk.bold.cyan('[步骤 1/5] 抓取链接并进行资格赛筛选'), { padding: 1, margin: { top: 1, bottom: 1 }, borderStyle: 'round', borderColor: 'cyan' }));
        const qualificationProgressBar = multiBar.create(1, 0, { step: chalk.magenta.bold('资格赛'.padStart(6)) });
        const contenders = await discoverAndRankContenders(spinner, qualificationProgressBar);
        multiBar.remove(qualificationProgressBar);

        if (contenders.length === 0) {
            console.log(chalk.green('\n任务完成。根据筛选标准，未发现足够进入决赛圈的文章。'));
            logger.info('任务正常结束，未发现高价值文章。');
            await gracefulShutdown();
            return;
        }

        // --- 步骤 2: 文章聚类与去重 ---
        console.log(boxen(chalk.bold.cyan('[步骤 2/5] 基于关键词的文章聚类与去重'), { padding: 1, margin: { top: 1, bottom: 1 }, borderStyle: 'round', borderColor: 'cyan' }));
        const groupingProgressBar = multiBar.create(contenders.length, 0, { step: chalk.cyan.bold('文章聚类'.padStart(6)) });
        const uniqueContenders = await groupAndDeduplicateArticles(contenders, groupingProgressBar);
        multiBar.remove(groupingProgressBar);
        console.log(chalk.cyan.bold(`\n✅ 聚类完成! 从 ${contenders.length} 篇候选文章中筛选出 ${uniqueContenders.length} 篇独特的文章进入决赛圈.`));

        // --- 步骤 3: 决赛圈排名 ---
        console.log(boxen(chalk.bold.cyan('[步骤 3/5] 决赛圈锦标赛排名'), { padding: 1, margin: { top: 1, bottom: 1 }, borderStyle: 'round', borderColor: 'cyan' }));
        const tournamentProgressBar = multiBar.create(1, 0, { step: chalk.yellow.bold('决赛圈'.padStart(6)) });
        const rankedArticles = await runFinalTournament(uniqueContenders, tournamentProgressBar);
        multiBar.remove(tournamentProgressBar);
        console.log(chalk.cyan.bold(`\n✅ 决赛圈完成! 共有 ${rankedArticles.length} 篇最终候选文章.`));

        // --- 步骤 4: 处理文章与生成报告 (已重构为顺位继承机制) ---
        console.log(boxen(chalk.bold.cyan(`[步骤 4/5] 逐篇处理高价值文章 (目标: ${articlesToProcessGoal}篇，带顺位递补)`), { padding: 1, margin: { top: 1, bottom: 1 }, borderStyle: 'round', borderColor: 'cyan' }));
        const processingProgressBar = multiBar.create(articlesToProcessGoal, 0, { step: chalk.blue.bold('文章处理'.padStart(6)) });

        const successfulArticles = [];
        let contenderIndex = 0;

        while (successfulArticles.length < articlesToProcessGoal && contenderIndex < rankedArticles.length) {
            const articleToTry = rankedArticles[contenderIndex];
            const statusTitle = (articleToTry.title || '未知标题').slice(0, 35);
            processingProgressBar.update({ status: `[尝试 ${contenderIndex + 1}/${rankedArticles.length}] ${statusTitle}...` });

            try {
                const processedArticle = await attemptToProcessArticle(
                    articleToTry,
                    successfulArticles.length, // 使用成功文章数作为文件名前缀的索引
                    dailyOutputDir
                );
                successfulArticles.push(processedArticle);
                processingProgressBar.increment(1, { status: `[成功] ${processedArticle.title.slice(0, 30)}...` });
                logger.info(`成功处理第 ${successfulArticles.length}/${articlesToProcessGoal} 篇: ${processedArticle.title}`);
            } catch (error) {
                logger.warn(`候选文章《${articleToTry.title}》处理失败，将尝试下一篇。原因: ${error.message}`);
                // 失败时，不增加进度条，只移动到下一个候选者
            }
            contenderIndex++; // 无论成功失败，都继续尝试下一个候选者
        }

        processingProgressBar.stop();
        successfulArticleCount = successfulArticles.length;

        if (successfulArticleCount < articlesToProcessGoal) {
            console.log(chalk.yellow.bold(`\n⚠️  警告: 已尝试所有 ${rankedArticles.length} 篇候选文章，但仅成功处理 ${successfulArticleCount} 篇，未达到 ${articlesToProcessGoal} 篇的目标。`));
            logger.warn(`处理目标未达成。目标: ${articlesToProcessGoal}, 成功: ${successfulArticleCount}`);
        } else {
            console.log(chalk.cyan.bold(`\n✅ 处理完成! 已成功处理 ${successfulArticleCount} 篇文章.`));
        }

        // --- 步骤 5: 生成最终简报 ---
        console.log(boxen(chalk.bold.cyan('[步骤 5/5] 生成最终简报'), { padding: 1, margin: { top: 1, bottom: 1 }, borderStyle: 'round', borderColor: 'cyan' }));
        const output = await generateFinalReport(successfulArticles, dailyOutputDir, spinner);

        multiBar.stop();

        // 输出最终的任务总结信息
        if (output) {
            const summaryBox = boxen(
                `${chalk.bold.green('🎉 所有任务已成功完成!')}\n\n` +
                `主报告已保存至: ${chalk.yellow(output.reportFilePath)}\n\n` +
                `处理目标: ${articlesToProcessGoal} 篇\n` +
                `最终成功: ${chalk.green(successfulArticleCount)} 篇\n` +
                `最终失败/跳过: ${chalk.red(contenderIndex - successfulArticleCount)} 篇\n\n` +
                `每篇文章的独立Markdown报告保存在:\n${chalk.yellow(output.individualArticlesDir)}`,
                { padding: 1, margin: 1, borderStyle: 'round', borderColor: 'green', title: '任务总结' }
            );
            console.log(summaryBox);
        } else if (successfulArticleCount === 0) {
             console.log(boxen(
                `${chalk.bold.yellow('⚠️  任务已结束，但未能成功处理任何文章。')}\n\n` +
                `尝试处理文章数: ${contenderIndex} 篇\n` +
                `成功生成报告篇数: ${chalk.green(0)} 篇\n\n` +
                `请检查日志文件获取详细的错误信息。`,
                { padding: 1, margin: 1, borderStyle: 'round', borderColor: 'yellow', title: '任务总结' }
            ));
        }

        await gracefulShutdown();

    } catch (error) {
        spinner.fail(chalk.red.bold(`主流程发生严重错误: ${error.message}`));
        multiBar.stop();
        await gracefulShutdown(error);
    }
}

// --- 全局进程异常捕获 ---
process.on('unhandledRejection', (reason, promise) => {
    const error = new Error(`未处理的Promise拒绝: ${reason instanceof Error ? reason.message : reason}`);
    gracefulShutdown(error);
});

process.on('uncaughtException', (error, origin) => {
    error.message = `未捕获的异常 (${origin}): ${error.message}`;
    gracefulShutdown(error);
});

// --- 启动程序 ---
main();