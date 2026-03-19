/**
 * Skills 模块
 * 扫描并解析 skill 目录
 */
export interface SkillItem {
    name: string;
    description: string;
}
/**
 * 解析 SKILL.md 的 YAML frontmatter（零外部依赖）
 * 必须以 --- 开头，需要两个 --- 才有效
 */
export declare function parseFrontmatter(content: string): Record<string, string>;
/**
 * 扫描指定目录下的 skills，返回按 name 排序的列表
 */
export declare function listSkills(skillsDir: string): SkillItem[];
/** 清除缓存（测试用） */
export declare function clearSkillsCache(): void;
//# sourceMappingURL=skills.d.ts.map