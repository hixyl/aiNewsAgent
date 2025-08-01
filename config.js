// config.js

import path from 'path';
import { fileURLToPath } from 'url';

// --- ES Module 环境下的 __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @description 应用程序的核心配置对象
 */
const CONFIG = {
    // 任务定义
    taskDescription: '为中国大陆的读者提供一份关于国家重要新闻的每日简报。',
    startUrl: 'https://www.news.cn/',

    // 调试与输出
    debugMode: false, // 设置为 true 可在控制台看到详细的 LLM 请求日志
    outputBaseDir: path.join(__dirname, 'output'),

    // 网络相关
    network: {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        },
        fetchTimeout: 20000, // 页面抓取超时时间 (ms)
    },

    // 爬取与链接筛选
    crawling: {
        maxDepth: 2, // 爬取最大深度
        maxCategoriesToExplore: 12, // 在每个深度，从识别出的栏目中，选出最重要的N个进行下一步探索
        categoryRankingGroupSize: 10, // 栏目排名时，每组比较的栏目数量
        categoryRankingPoints: [5, 3, 2, 1, 0], // 栏目排名得分
        uselessTitleKeywords: ['关于我们', '联系我们', '隐私政策', '登录', '注册', '下载', '更多', '广告', '订阅'],
    },

    // 锦标赛排名配置
    ranking: {
        // --- 资格赛配置 ---
        qualificationRounds: 2,
        qualificationGroupSize: 10,
        qualificationTopN: 3,
        qualificationPoints: [5, 3, 2, 1, 0],
        qualificationConcurrency: 10,

        // --- (新) 稳健聚类配置 ---
        groupingBatchSize: 25,     // 阶段一和二中，每批处理的文章数量
        maxGroupingCycles: 3,      // 聚类过程的最大迭代轮次，防止无限循环

        // --- 决赛圈配置 ---
        contendersToRank: 60,
        tournamentRounds: 3,
        tournamentGroupSize: 3,
        tournamentPoints: [3, 1, 0],
        tournamentConcurrency: 8,
    },

    // 文章处理
    processing: {
        maxArticlesToProcess: 15,
        minContentLength: 60,
        maxOverallRetries: 5,
        recencyBonus: {
            maxBonus: 20,
            maxDays: 7,
        }
    },

    // 大语言模型 (LLM)
    llm: {
        studioUrl: 'http://localhost:1234/v1/chat/completions',
        maxRetries: 1,
        retryDelay: 1000,
        requestTimeout: 120000,
        longRequestTimeout: 300000,
        maxTokens: 999999,
    },

    // 输出格式化
    output: {
        categoryEmojis: { '国际': '🌍', '国内': '🇨🇳', '财经': '💼', '科技': '🔬', '社会': '👥', '观点': '✍️', '其他': '📰', '默认': '📰' }
    },

    // Prompt 模板中心
    prompts: {
        qualifyLinks: (linkTitles, taskDescription) => ({
            system: '你是一位反应迅速、判断精准的新闻编辑，任务是快速判断在一组新闻标题中，哪些对目标读者最重要。你的回应必须极端简洁，严格遵循格式。内容使用简体中文。',
            user: `**任务目标**: “${taskDescription}”\n\n**待评估的标题列表**:\n${linkTitles.map((title, i) => `${i + 1}. ${title}`).join('\n')}\n\n**你的指令**:\n根据任务目标，对列表中的标题进行重要性排序。你的回应【只能】是标题的【编号】，从最重要到最不重要排列，并用英文逗号 (,) 分隔。不要包含任何理由、解释或多余的文字。\n\n**格式示例**: 3,1,2,5,4\n\n**你的回应**:`,
        }),

        rankCategories: (categoryTitles, taskDescription) => ({
            system: '你是一位经验丰富的新闻网站总编辑，任务是判断在一组“新闻栏目”中，哪些对于目标读者来说最有可能包含重要新闻,比较好的栏目名类似于[财经][科技][国际][亚洲新闻]这种,不好的栏目名类似于[中国政府网][公司官网][联系我们]这种,如果你认为这个栏目可能会指向别的网站,排序就放到后面。你的回应必须极端简洁，严格遵循格式。内容使用简体中文。',
            user: `**任务目标**: “${taskDescription}”\n\n**待评估的“栏目”标题列表**:\n${categoryTitles.map((title, i) => `${i + 1}. ${title}`).join('\n')}\n\n**你的指令**:\n根据任务目标，对列表中的栏目标题进行重要性排序。你的回应【只能】是栏目的【编号】，从最重要到最不重要排列，并用英文逗号 (,) 分隔。不要包含任何理由、解释或多余的文字。\n\n**格式示例**: 3,1,2,5,4\n\n**你的回应**:`,
        }),
        
        classifyLinkType: (linkTitle) => ({
            system: '你是一个链接分类工具，任务是判断一个链接标题指向的是“文章页面”还是“栏目列表页面”。你的回应必须是单个词。内容使用简体中文。',
            user: `请判断以下链接标题更可能是一个具体的新闻“文章”（article）还是一个新闻“栏目”（category）。\n标题：“${linkTitle}”\n\n你的回应只能是 "article" 或 "category"。\n\n回应:`,
        }),
        
        // (新) 聚类第一步：找出高度相似的配对
        findSimilarPairs: (articles) => ({
            system: '你是一个高精度的文本匹配工具。你的任务是在一个标题列表中，找出那些报道【完全相同核心事件】的标题对。你的回应必须极端简洁，严格遵循格式。',
            user: `
**任务**: 从下面的“文章列表”中，找出内容高度相似的标题【对】。

**文章列表**:
${articles.map((art, i) => `ID_${i}: "${art.title}"`).join('\n')}

**你的指令**:
1.  仔细比对列表中的每一个标题。
2.  如果两个标题明确指向同一个新闻事件（例如，只是来源不同或措辞略有差异），则将它们的ID配对。
3.  你的回应【只能】是一个JSON数组，每个元素是包含两个相似文章ID（数字）的数组。
4.  如果找不到任何相似的配对，请返回一个空数组 \`[]\`。

**# 绝对规则**
- 只找出最明确、最有把握的配对。宁缺毋滥。
- 你的回应【必须且只能】是一个纯粹的JSON数组。

**格式示例**:
[
  [0, 5],
  [2, 8]
]

**请严格遵照以上所有规则，开始生成你的JSON数组：**
`
        }),

        // (新) 聚类第二步：将候选者与已有的代表簇进行匹配
        groupAgainstRepresentatives: (representatives, candidates) => ({
            system: '你是一个新闻分类引擎。你的任务是判断一批“待分类文章”是否与已有的“代表性议题”在核心事件上相同。你的回应必须是一个纯粹的、格式完美的JSON对象。',
            user: `
**任务**: 将“待分类文章”列表中的每一篇文章，与“代表性议题”列表进行匹配。

**代表性议题 (由其标题表示)**:
${representatives.map((rep, i) => `R_${i}: "${rep.title}"`).join('\n')}

**待分类文章**:
${candidates.map((cand, i) => `C_${i}: "${cand.title}"`).join('\n')}

**你的指令**:
1.  仔细阅读每个“待分类文章”的标题。
2.  判断它报道的核心事件是否与某个“代表性议题”完全一致。
3.  如果它与某个代表性议题相同，则将其归类到对应的代表ID (例如 "R_0", "R_1", ...)。
4.  如果它是一个全新的、独立的议题，请将其归类为【"new"】。
5.  你的回应【必须且只能】是一个JSON对象，其中key是待分类文章的ID (例如 "C_0"), value是它归属的代表ID或 "new"。

**格式示例**:
{
  "C_0": "R_1",
  "C_1": "new",
  "C_2": "R_1",
  "C_3": "R_0"
}

**请严格遵照以上所有规则，开始生成你的JSON对象：**
`
        }),
        
        // (复用) 聚类第三步（可选）：验证簇内部的一致性
        verifyClusterConsistency: (theme, titles) => ({
            system: '你是一个严谨的内容审核员，负责检验一组新闻标题是否都严格符合给定的核心议题。你的回应必须极端简洁，严格遵循格式。内容使用简体中文。',
            user: `**核心议题**: "${theme}"

**待检验的新闻标题列表**:
${titles.map((title, i) => `${i + 1}. "${title}"`).join('\n')}

**你的指令**:
判断列表中的每一个标题，是否与“核心议题”报道的是同一件事。
你的回应【只能】是【不符合】议题的标题的【编号】，用英文逗号 (,) 分隔。
如果所有标题都符合议题，请回应 "none"。

**格式示例 1 (有不符合的)**: 3,5
**格式示例 2 (全部符合)**: none

**你的回应**:`,
        }),
        
        // (复用) 为最终的簇生成一个精炼的主题
        generateClusterTheme: (titles) => ({
            system: '你是一位顶级的议题分析师，擅长从一组相似的新闻标题中，提炼出最核心、最精炼的议题名称。你的回应必须极端简洁。内容使用简体中文。',
            user: `**任务**: 根据以下新闻标题列表，生成一个不超过15个字的、高度概括的“议题名称”。

**新闻标题列表**:
${titles.map(title => `- "${title}"`).join('\n')}

**你的指令**:
分析以上所有标题，总结它们共同报道的核心事件，并给出一个简短的议题名称。你的回应【只能】是议题名称本身，不能包含任何引号、解释或其他文字。

**格式示例**: 俄乌冲突新一轮谈判
**你的回应**:`,
        }),


        rankContenders: (articles, taskDescription) => ({
            system: '你是一位顶级的、拥有宏观视野,视角全面且客观的总编辑，任务是判断在一组新闻中，哪些对于目标读者最重要、最具有新闻价值。你的判断必须果断、精准，且严格遵循输出格式。内容使用简体中文。',
            user: `**任务目标**: “${taskDescription}”\n\n**待排名新闻列表**:\n${articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n')}\n\n**你的指令**:\n请根据上述任务目标，对列表中的新闻进行重要性排序。你的回应【只能】是新闻的【编号】，从最重要到最不重要排列，并用英文逗号 (,) 分隔。不要包含任何理由、解释或多余的文字。\n\n**格式示例**: 3,1,2\n\n**你的回应**:`,
        }),
        
        processArticleSingleCall: (articleContent, originalTitle, isCluster = false) => ({
            system: '你是一位顶尖的新闻分析师和内容创作者，擅长从海量信息中提炼价值、深度解读，并以专业且亲民的语言呈现。你的输出必须是一个纯粹、格式完美的JSON对象。',
            user: `
**分析材料**:
---
${articleContent}
---

**你的任务**:
根据以上提供的一篇或多篇相关新闻原文，执行下列所有指令，并生成一个【单一、完整、无任何多余内容】的JSON对象回复。

**# JSON对象结构定义**
1.  \`"title"\`: (string) 生成一个全新的、高度精炼、中立客观且信息量丰富的中文标题。
2.  \`"conciseSummary"\`: (string) 用一句话（不超过60字）凝练出整个事件的核心内容。
3.  \`"keywords"\`: (string[]) 提取3-5个最关键的核心词，存为JSON字符串数组。
4.  \`"category"\`: (string) 从 ['国际', '国内', '财经', '科技', '社会', '观点', '其他'] 中选择一个最匹配的分类。
5.  \`"detailedSummary"\`: (string) 
    ${isCluster 
        ? `**[!! 已聚合多篇报道 !!]** 这是一组关于同一主题的相关报道，请执行以下特殊指令：
        a. **综合信息**: 不要只复述单篇文章，而是对比、整合所有信源的关键信息（时间、地点、人物、数据、各方观点等）。
        b. **提炼共识与差异**: 如果报道中有细节冲突或不同的侧重，可以简要提及。
        c. **形成统一叙事**: 最终产出一段连贯、流畅、结构清晰的深度综述（约300-900字），就像一篇独立的深度分析文章。语言风格要求专业且亲民，易于理解。
        d. **提供洞见**: 在事实陈述的基础上，可以加上一两句简短的背景分析或事件点评，提升摘要的深度。`
        : `撰写一篇详尽、流畅、结构清晰的深度摘要（约200-800字）。如果原文信息丰富，字数可适度增加。摘要应包含事件的关键要素（时间、地点、人物、起因、经过、结果等），可使用Markdown换行符 \`\\n\` 和列表来增强可读性。`
    }

**# 绝对规则**
1.  **【规则1：纯净JSON】** 你的整个回复【必须且只能】是一个完整的JSON对象，从 \`{\` 开始，到 \`}\` 结束。
2.  **【规则2：无外部文本】** 严禁在JSON对象前后添加任何文本、注释、或Markdown代码块标记。

**请严格遵照以上所有规则，开始生成你的JSON对象：**
`
        }),
        
        generateEditorIntro: (conciseSummariesText) => ({
            system: '你是一位视野宏大、洞察力敏锐、文笔老练的资深总编辑。你的任务是为今日的新闻简报撰写一段画龙点睛的开篇导语。',
            user: `**任务**: 基于以下今日核心新闻的一句话摘要，撰写一段约200-300字的“总编导语”。

**写作要求:**
1.  **宏大叙事**: 不要罗列新闻，而是从全局高度，提炼出当日最值得关注的1-2个核心趋势或主题。
2.  **深度洞察**: 指出不同新闻事件之间潜在的逻辑联系或因果关系。它们共同揭示了什么更深层次的现象或问题？
3.  **预见未来**: 在分析的基础上，可以对事件的未来走向或可能产生的影响，给出一个简短、有力的预判或点拨。
4.  **专业文笔**: 语言风格要求沉稳、精炼、富有洞见，能引发读者思考。
5.  **纯净输出**: 你的回应【只能】包含导语本身，禁止任何额外文字、标题或问候语。

---[今日核心新闻摘要]---
${conciseSummariesText}
---

**你的导语**:
`
        }),
    }
};

export default CONFIG;