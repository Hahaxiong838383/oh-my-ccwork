#!/bin/bash
# 多智能体协同 - 工作流脚本（带门禁）

set -e

# 加载环境变量
source ~/.zshrc 2>/dev/null || true

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="${1:-.}"
CONTEXT_DIR="$PROJECT_DIR/.claude/multi-agent/context"

# 检查门禁
check_gate() {
    local gate_name="$1"
    local passed=true

    case "$gate_name" in
        layer1)
            # Layer 1 门禁：必须有 SPEC + AC
            if [ ! -f "$CONTEXT_DIR/SPEC.md" ]; then
                echo -e "${RED}✗ 门禁失败: SPEC.md 不存在${NC}"
                passed=false
            fi
            if [ ! -f "$CONTEXT_DIR/AC.md" ]; then
                echo -e "${RED}✗ 门禁失败: AC.md 不存在${NC}"
                passed=false
            fi
            if [ ! -f "$CONTEXT_DIR/ARCH.md" ]; then
                echo -e "${RED}✗ 门禁失败: ARCH.md 不存在${NC}"
                passed=false
            fi
            if [ ! -f "$CONTEXT_DIR/EXAMPLES.jsonl" ]; then
                echo -e "${RED}✗ 门禁失败: EXAMPLES.jsonl 不存在${NC}"
                passed=false
            fi
            ;;
        layer2)
            # Layer 2 门禁：必须有 Layer 1 产出
            check_gate layer1 || return 1
            # 检查 AC 格式（至少包含测试用例段）
            if ! grep -q "TC-" "$CONTEXT_DIR/AC.md" 2>/dev/null; then
                echo -e "${RED}✗ 门禁失败: AC.md 缺少测试用例（TC-xxx）${NC}"
                passed=false
            fi
            ;;
        layer3)
            # Layer 3 门禁：必须有实现代码
            check_gate layer2 || return 1
            if [ ! -d "$PROJECT_DIR/src" ]; then
                echo -e "${RED}✗ 门禁失败: src/ 目录不存在${NC}"
                passed=false
            fi
            ;;
        layer4)
            # Layer 4 门禁：必须通过 Layer 3 验收
            check_gate layer3 || return 1
            ;;
    esac

    if [ "$passed" = true ]; then
        echo -e "${GREEN}✓ 门禁通过: $gate_name${NC}"
        return 0
    else
        echo -e "${RED}✗ 无法进入 $gate_name${NC}"
        return 1
    fi
}

# 显示工作流状态
show_status() {
    echo -e "${BLUE}=== 多智能体协同工作流 ===${NC}"
    echo ""

    # 检查 SPEC
    if [ -f "$CONTEXT_DIR/SPEC.md" ]; then
        echo -e "${GREEN}✓${NC} SPEC.md"
    else
        echo -e "${RED}✗${NC} SPEC.md"
    fi

    # 检查 AC
    if [ -f "$CONTEXT_DIR/AC.md" ]; then
        echo -e "${GREEN}✓${NC} AC.md"
    else
        echo -e "${RED}✗${NC} AC.md"
    fi

    # 检查 ARCH
    if [ -f "$CONTEXT_DIR/ARCH.md" ]; then
        echo -e "${GREEN}✓${NC} ARCH.md"
    else
        echo -e "${RED}✗${NC} ARCH.md"
    fi

    # 检查 EXAMPLES
    if [ -f "$CONTEXT_DIR/EXAMPLES.jsonl" ]; then
        echo -e "${GREEN}✓${NC} EXAMPLES.jsonl"
    else
        echo -e "${RED}✗${NC} EXAMPLES.jsonl"
    fi

    # 检查实现
    if [ -d "$PROJECT_DIR/src" ]; then
        echo -e "${GREEN}✓${NC} src/"
    else
        echo -e "${YELLOW}○${NC} src/"
    fi

    # 检查测试
    if [ -d "$PROJECT_DIR/tests" ]; then
        echo -e "${GREEN}✓${NC} tests/"
    else
        echo -e "${YELLOW}○${NC} tests/"
    fi
}

# Layer 1: 生成规格
layer1_spec() {
    echo -e "${BLUE}Layer 1: 规格与合同（Claude 负责）${NC}"
    echo ""

    # 检查门禁
    if check_gate layer1; then
        echo -e "${GREEN}✓ Layer 1 已完成${NC}"
        return 0
    fi

    echo ""
    echo "请创建以下文件："
    echo "1. SPEC.md - 规格说明"
    echo "2. AC.md - 验收标准（必须包含 TC-xxx 测试用例）"
    echo "3. ARCH.md - 架构设计"
    echo "4. EXAMPLES.jsonl - 示例数据"
    echo ""
    echo -e "存储位置: ${GREEN}$CONTEXT_DIR${NC}"
    echo ""
    echo -e "${YELLOW}⚠️  没有完成 Layer 1 禁止进入 Layer 2！${NC}"
}

# Layer 2: 并行生成
layer2_generate() {
    echo -e "${BLUE}Layer 2: 并行生成${NC}"
    echo ""

    # 门禁检查
    if ! check_gate layer2; then
        echo -e "${RED}✗ 无法进入 Layer 2${NC}"
        echo -e "${YELLOW}请先完成 Layer 1（创建 SPEC/AC/ARCH/EXAMPLES）${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ 门禁通过，开始 Layer 2${NC}"
    echo ""
    echo "执行步骤："
    echo "1. Codex: 主实现"
    echo "   使用 MCP 工具: ask_codex"
    echo "   agent_role: executor"
    echo ""
    echo "2. Gemini: 对照实现 + 边界case"
    echo "   使用 MCP 工具: ask_gemini"
    echo "   agent_role: scientist"
    echo ""
    echo "3. 验证实现是否匹配 SPEC"
}

# Layer 3: 自动化验收
layer3_verify() {
    echo -e "${BLUE}Layer 3: 自动化验收${NC}"
    echo ""

    # 门禁检查
    if ! check_gate layer3; then
        echo -e "${RED}✗ 无法进入 Layer 3${NC}"
        echo -e "${YELLOW}请先完成 Layer 2（实现代码）${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ 门禁通过，开始 Layer 3${NC}"
    echo ""
    echo "执行验收测试："
    echo "1. 单元测试: npm test"
    echo "2. 示例数据对比"
    echo "3. 静态检查: npm run lint"
    echo "4. 类型检查: npm run type-check"
    echo ""
    echo -e "${YELLOW}⚠️  验收必须通过才能进入 Layer 4！${NC}"
}

# Layer 4: 最终裁决
layer4_decide() {
    echo -e "${BLUE}Layer 4: 最终裁决（Claude 负责）${NC}"
    echo ""

    # 门禁检查
    if ! check_gate layer4; then
        echo -e "${RED}✗ 无法进入 Layer 4${NC}"
        echo -e "${YELLOW}请先通过 Layer 3 验收${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ 门禁通过，开始 Layer 4${NC}"
    echo ""
    echo "执行步骤："
    echo "1. 审查测试覆盖是否满足 AC"
    echo "2. 判断是否偏离 SPEC"
    echo "3. 合并最佳方案"
    echo "4. 输出最终 REVIEW.md"
    echo ""
    echo -e "${GREEN}✓ 工作流完成！${NC}"
}

# 创建 checkpoint
create_checkpoint() {
    local msg="$1"
    if [ -z "$msg" ]; then
        msg="工作流 checkpoint"
    fi
    cd "$PROJECT_DIR"
    git add -A
    git commit -m "checkpoint: $msg" || echo "没有需要提交的更改"
    echo -e "${GREEN}✓ checkpoint 创建成功: $msg${NC}"
}

# 显示帮助
show_help() {
    echo "多智能体协同工作流（带门禁）"
    echo ""
    echo "用法: $0 <project-dir> <command>"
    echo ""
    echo "命令:"
    echo "  status         显示当前状态"
    echo "  layer1        进入 Layer 1（如门禁通过）"
    echo "  layer2        进入 Layer 2（如门禁通过）"
    echo "  layer3        进入 Layer 3（如门禁通过）"
    echo "  layer4        进入 Layer 4（如门禁通过）"
    echo "  checkpoint    创建 checkpoint"
    echo "  all           显示完整流程"
    echo "  gate <layer>  检查指定层门禁"
    echo "  help          显示帮助"
}

# 主命令处理
case "${2:-status}" in
    status)
        show_status
        ;;
    layer1)
        layer1_spec
        ;;
    layer2)
        layer2_generate
        ;;
    layer3)
        layer3_verify
        ;;
    layer4)
        layer4_decide
        ;;
    checkpoint)
        create_checkpoint "$3"
        ;;
    gate)
        check_gate "$3"
        ;;
    all)
        show_status
        echo ""
        layer1_spec
        echo ""
        layer2_generate
        echo ""
        layer3_verify
        echo ""
        layer4_decide
        ;;
    help|*)
        show_help
        ;;
esac
