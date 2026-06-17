#!/bin/bash
set -euo pipefail

DRY_RUN=${DRY_RUN:-1}
SOURCE_DIR="$HOME/mycc/0-System"
GLOBAL_DIR="$HOME/.mycc-global/0-System"
BACKUP_DIR="$HOME/Archive"
BACKUP_FILE="$BACKUP_DIR/0-System-backup-$(date +%Y%m%d%H%M%S).tar"

log() { echo -e "\033[1;34m[INFO]\033[0m $1"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $1"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $1"; exit 1; }

# === 验证环节 ===
verify_pre() {
    if [ -L "$SOURCE_DIR" ]; then
        error "$SOURCE_DIR 已经是软链接，无需迁移。"
    fi
    if [ ! -d "$SOURCE_DIR" ]; then
        error "$SOURCE_DIR 不存在或不是目录。"
    fi
}

rollback() {
    warn "执行回滚操作..."
    if [ -L "$SOURCE_DIR" ]; then
        rm "$SOURCE_DIR"
    fi
    if [ -d "${SOURCE_DIR}.old" ]; then
        mv "${SOURCE_DIR}.old" "$SOURCE_DIR"
        log "已从 .old 恢复 $SOURCE_DIR"
    fi
    warn "回滚完成。请手工检查状态。"
}

# === 核心执行 ===
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        log "DRY_RUN 模式，以下操作将不会真正执行（设置 DRY_RUN=0 运行）"
    fi

    # 1. 强备份
    log "1. 创建强备份: $BACKUP_FILE"
    if [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "$BACKUP_DIR"
        tar -cf "$BACKUP_FILE" -C "$HOME/mycc" 0-System
    fi

    # 2. 准备全局目录
    log "2. 准备全局目录并初次同步: $GLOBAL_DIR"
    if [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "$GLOBAL_DIR"
        # 使用 rsync -a 保留权限、软链、隐藏文件等
        rsync -a "$SOURCE_DIR/" "$GLOBAL_DIR/"
    fi

    # 3. 短暂原子替换与竞态追平
    log "3. 原子替换 (mv + ln) 并追平竞态写入"
    if [ "$DRY_RUN" -eq 0 ]; then
        trap rollback ERR
        
        # 短暂的不可达窗口
        mv "$SOURCE_DIR" "${SOURCE_DIR}.old"
        ln -s "$GLOBAL_DIR" "$SOURCE_DIR"
        
        # 防竞态：如果有其他 session 在上述窗口期间写了已打开的文件句柄，
        # 数据会落在 .old 里。我们用 rsync -au 再次同步更新过的文件。
        rsync -au "${SOURCE_DIR}.old/" "$GLOBAL_DIR/"
        
        trap - ERR
    fi

    # 4. Git 验证与提交
    log "4. Git 提交 Tracked Symlink"
    if [ "$DRY_RUN" -eq 0 ]; then
        cd "$HOME/mycc"
        git add 0-System
        # 验证 Tracked 数变化
        log "检查 Git 状态 (注意 0-System 下原文件会被视为 deleted，因为已被替换为 symlink)"
        git status --short 0-System | head -n 10
        git commit -m "chore: externalize 0-System to tracked symlink"
    fi

    # 5. 验证读写透明
    log "5. 验证结果"
    if [ "$DRY_RUN" -eq 0 ]; then
        if [ ! -L "$SOURCE_DIR" ]; then
            error "验证失败：$SOURCE_DIR 不是软链接"
        fi
        orig_count=$(find "${SOURCE_DIR}.old" -type f | wc -l)
        new_count=$(find "$GLOBAL_DIR" -type f | wc -l)
        log "文件数比对: Old=$orig_count, Global=$new_count"
        if [ "$orig_count" -ne "$new_count" ]; then
            warn "文件数量不一致，可能存在并发写入，请检查。"
        else
            log "文件数验证一致！"
        fi
        log "P0-P2 迁移脚本执行成功！旧数据保留在 ${SOURCE_DIR}.old"
    fi
}

verify_pre
run
