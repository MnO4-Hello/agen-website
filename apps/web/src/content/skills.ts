/**
 * “我会什么？”板块的文案。
 *
 * 和 profile.ts 一样，把字和布局分开：改文案不必碰动画代码。
 */

/** 板块标题。入场时四个字从屏幕上方落下。 */
export const SKILLS_TITLE = '我会什么？';

/** 卡牌数量（扇形展开）。 */
export const SKILLS_CARD_COUNT = 5;

/** 粒子团下方的提示语。 */
export const SKILLS_PICK_HINT = '请选择卡片';

/** 副提示。 */
export const SKILLS_PICK_SUB = '（悬停卡片查看作品，点击卡片将其固定）';

/** 固定之后卡片右下角那枚胶囊上的文字。 */
export const SKILLS_RELEASE_TEXT = '放下';

/** 胶囊按钮的无障碍名称。 */
export const SKILLS_RELEASE_LABEL = '放下卡牌';

// -- 卡面内容 ---------------------------------------------------------------

/**
 * 右侧对比组件里的一层（一个制作阶段的图）。
 * `src` 相对站点根（`public/` 会被 Vite 原样发布到根），用稳定英文名，
 * 以后换素材只换文件、不动代码。
 */
export interface CompareLayer {
  /** 语义化的阶段键。 */
  key: 'clay' | 'render' | 'grade';
  /** 图片地址，相对于站点根。 */
  src: string;
  /** 替代文本，只给屏幕阅读器看——图上不渲染任何可见标签。 */
  alt: string;
}

/**
 * 代码打字机场景里的语言键（决定关键字表、注释族与配色，见 scene/code-typing.ts）。
 */
export type CodeLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'r'
  | 'bash'
  | 'lua'
  | 'haskell'
  | 'html';

/** 一段 Hello World 源码（纯数据，不含 token——着色由 scene/code-typing.ts 预计算）。 */
export interface CodeSnippet {
  /** 编辑器 chrome 上的语言名，如 'Python'。 */
  readonly label: string;
  /** 高亮用语言键，决定关键字表与注释族。 */
  readonly lang: CodeLanguage;
  /** 源码逐行；缩进用空格，别用 tab。 */
  readonly lines: readonly string[];
}

/** AI 对话模拟里的一组问答（配套 `scene: 'ai-lab'`，见 scene/ai-lab.ts）。 */
export interface ChatTurn {
  /** 在输入框里逐字打进、再发出去的那句话。 */
  readonly user: string;
  /** AI「思考中」之后逐字吐出来的回复。 */
  readonly ai: string;
}

/**
 * 右栏场景 id。
 *
 * 已知取值列在前面给补全提示，同时用 `(string & {})` 让其它卡片 / 其它协作者可以
 * 直接引入新场景 id，而不必回来改这个联合类型（新增场景在
 * `sections/skills.ts` 的 `SKILL_SCENE_FACTORIES` 里登记）。
 */
export type SkillSceneId = 'ps-bulb' | (string & {});

/** 一张技能卡的内容。 */
export interface SkillCardContent {
  /** 卡面大标题。 */
  title: string;
  /** 卡面说明小字。 */
  blurb: string;
  /** 选中此卡时右栏展示的多图对比；缺省则右栏保持粒子团。 */
  compare?: {
    /** 按数组顺序 左 → 右 叠放（第一个在最底层）。 */
    layers: readonly CompareLayer[];
  };
  /**
   * 选中此卡时右栏挂载的自定义场景 id（注册于 `sections/skills.ts`）。
   *
   * 右栏解析优先级：`scene` → `compare`（≥2 层）→ 粒子团（默认）。
   */
  scene?: SkillSceneId;
  /**
   * 选中此卡时右栏展示的「代码打字机」脚本，配套 `scene: 'code-typing'`。
   *
   * `scene` 决定挂哪个场景，`code.snippets` 是喂给它的数据——每段一门语言，循环
   * 逐字符打出、再逐字符删掉。
   */
  code?: {
    /** 循环播放的 Hello World 片段。 */
    snippets: readonly CodeSnippet[];
  };
  /**
   * 选中此卡时左栏「AI 对话模拟」循环播放的问答，配套 `scene: 'ai-lab'`。
   *
   * 数组走完再从头开始、无限循环；十组左右长度最合适。
   */
  chat?: {
    readonly turns: readonly ChatTurn[];
  };
}

/**
 * 素材映射（换图时只替换 `apps/web/public/skills/` 下的同名文件即可）：
 *
 *   3d-clay.jpg   ← 01_白模.jpg      (1920×1080)
 *   3d-render.jpg ← 02_渲染.jpg      (1920×1080)
 *   3d-grade.jpg  ← 03_后期处理.jpg  (1920×1080)
 */
export const SKILLS_CARDS: readonly SkillCardContent[] = [
  {
    title: '3D全流程',
    blurb:
      '精通 3D 全流程制作，熟练完成从概念构思、模型搭建、拓扑布线、UV 拆分、' +
      '材质绘制、灯光渲染到后期输出整套工作；掌握 Blender 等工具，可独立完成' +
      '写实 / 风格化三维资产，兼顾面数优化与视觉效果，具备项目资产规范交付能力。',
    compare: {
      layers: [
        { key: 'clay', src: './skills/3d-clay.jpg', alt: '白模' },
        { key: 'render', src: './skills/3d-render.jpg', alt: '初步渲染' },
        { key: 'grade', src: './skills/3d-grade.jpg', alt: '后期处理' },
      ],
    },
  },
  {
    title: '平面设计全流程',
    blurb:
      '熟练平面设计全流程，掌握海报、LOGO、宣传物料、图文排版设计；' +
      '精通 PS、AI，具备视觉构思、版式布局、色彩把控能力，可独立完成从需求梳理、' +
      '草图方案到成品输出，适配印刷与线上多平台使用规范。',
    // 右栏展示「类 PS 界面里拉框点亮灯泡」的脚本场景，见 scene/ps-bulb.ts。
    scene: 'ps-bulb',
  },
  {
    title: '编程',
    blurb:
      '掌握多门编程语言，熟悉 Python、Java 等开发基础，具备逻辑设计、代码编写、' +
      '调试排错能力；可独立完成小型程序开发、脚本自动化编写，了解基础数据结构，' +
      '能够结合设计需求开发辅助工具，实现设计工作流自动化。',
    // 右栏展示「深色代码编辑器里逐字符敲出各语言 Hello World」的场景，见 scene/code-typing.ts。
    scene: 'code-typing',
    code: {
      snippets: [
        { label: 'Python', lang: 'python', lines: ['# Python · 第 1 个程序', 'print("Hello, World!")'] },
        {
          label: 'JavaScript',
          lang: 'javascript',
          lines: ['// JavaScript', 'const n = 1;', 'console.log("Hello, World!", n);'],
        },
        {
          label: 'TypeScript',
          lang: 'typescript',
          lines: [
            '// TypeScript：带类型的问候',
            'const year = 2026;',
            'const greet = (name: string): string => `Hello, ${name}!`;',
            'console.log(greet("World"), year);',
          ],
        },
        {
          label: 'Java',
          lang: 'java',
          lines: [
            '// Java',
            'public class Hello {',
            '  public static void main(String[] args) {',
            '    System.out.println("Hello, World!");',
            '  }',
            '}',
          ],
        },
        {
          label: 'C',
          lang: 'c',
          lines: [
            '/* C 语言 */',
            '#include <stdio.h>',
            'int main(void) {',
            '  printf("Hello, World!\\n");',
            '  return 0;',
            '}',
          ],
        },
        {
          label: 'C++',
          lang: 'cpp',
          lines: [
            '// C++',
            '#include <iostream>',
            'int main() {',
            '  std::cout << "Hello, World!" << std::endl;',
            '  return 0;',
            '}',
          ],
        },
        {
          label: 'C#',
          lang: 'csharp',
          lines: [
            '// C#',
            'using System;',
            'class Program {',
            '  static void Main() {',
            '    Console.WriteLine("Hello, World!");',
            '  }',
            '}',
          ],
        },
        {
          label: 'Go',
          lang: 'go',
          lines: [
            '// Go',
            'package main',
            'import "fmt"',
            'func main() {',
            '  fmt.Println("Hello, World!")',
            '}',
          ],
        },
        { label: 'Rust', lang: 'rust', lines: ['// Rust', 'fn main() {', '  println!("Hello, World!");', '}'] },
        { label: 'Ruby', lang: 'ruby', lines: ['# Ruby', 'name = "World"', 'puts "Hello, #{name}!"'] },
        {
          label: 'PHP',
          lang: 'php',
          lines: ['<?php', '// PHP', '$name = "World";', 'echo "Hello, $name!";', '?>'],
        },
        { label: 'Swift', lang: 'swift', lines: ['// Swift', 'let name = "World"', 'print("Hello, \\(name)!")'] },
        {
          label: 'Kotlin',
          lang: 'kotlin',
          lines: ['// Kotlin', 'fun main() {', '  val name = "World"', '  println("Hello, $name!")', '}'],
        },
        { label: 'R', lang: 'r', lines: ['# R 语言', 'name <- "World"', 'cat("Hello,", name, "!\\n")'] },
        {
          label: 'Bash',
          lang: 'bash',
          lines: ['#!/usr/bin/env bash', '# Bash 脚本', 'name="World"', 'echo "Hello, $name!"'],
        },
        { label: 'Lua', lang: 'lua', lines: ['-- Lua', 'local name = "World"', 'print("Hello, " .. name .. "!")'] },
        { label: 'Haskell', lang: 'haskell', lines: ['-- Haskell', 'main :: IO ()', 'main = putStrLn "Hello, World!"'] },
        {
          label: 'HTML',
          lang: 'html',
          lines: ['<!-- HTML -->', '<!DOCTYPE html>', '<h1 class="title">Hello, World!</h1>'],
        },
      ],
    },
  },
  {
    title: 'AI 创意生产',
    blurb:
      '熟练运用 AI 全链路工具，支持 AI 写作、代码生成、图像与视频生成；掌握大模型本地部署基础，' +
      '能够结合三维、平面设计需求，利用 AI 辅助创意构思、素材生成、脚本自动化，' +
      '优化内容生产流程，完成从创意到素材的快速落地。',
    // 右栏左半播「AI 对话模拟」（turns 循环），右半播「由品牌字符拼成的 AI 图标」
    // ——六个 logo 之间来回形变，还带指针涟漪，见 scene/ai-lab.ts。
    scene: 'ai-lab',
    chat: {
      turns: [
        { user: '帮我写一段产品文案', ai: '已生成 3 版，风格偏科技、生活、极简。' },
        { user: '写个 Python 背单词脚本', ai: '好了，含词库读取与今日复习。' },
        { user: '生成一张赛博朋克海报', ai: '画面已出，青紫霓虹、雨夜街道。' },
        { user: '把分镜做成 5 秒动画', ai: '补间与运镜已排好，可直接预览。' },
        { user: '本地跑一个 7B 模型', ai: '显存够用，量化后约 5GB。' },
        { user: '给模型生成三视图', ai: '正视 / 侧视 / 顶视已输出。' },
        { user: '把这版排版再紧凑点', ai: '行距收 8%，留白更均匀了。' },
        { user: '想个中秋活动主题', ai: '给你 5 个方向，先看这三个。' },
        { user: '批量重命名这些素材', ai: '已按规则改好 128 个文件。' },
        { user: '配一张卡通封面', ai: '封面已生成，比例 16:9。' },
      ],
    },
  },
  {
    title: 'Office 办公',
    blurb:
      '熟练使用 Office 办公套件，精通 Word 文档排版、Excel 数据整理与基础函数、' +
      'PPT 演示文稿制作；可独立完成报告撰写、数据统计分析、演示视觉排版，' +
      '规范整理项目资料，高效输出各类办公文档。',
    // 右栏展示「纯代码仿真的 Word / Excel / PPT 界面循环播放」，见 scene/office-suite.ts。
    scene: 'office-suite',
  },
];
