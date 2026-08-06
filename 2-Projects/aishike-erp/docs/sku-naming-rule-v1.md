# 爱视可 SKU 命名规则 V1

> 来源：飞书表格《P003产品SKU规格名称-for产品BOM区分》Sheet1，读取日期：2026-08-06。

## 1. 编码格式

```text
EC-{ProductLine}-{Model}-{Screen}-{Bundle}-{Version}
```

示例：`EC-T&S-Max-V-S2-V2`。

| 维度 | 代码 | 含义 |
|---|---|---|
| ProductLine | `T` | 读写台 |
| ProductLine | `S` | 护眼屏 |
| ProductLine | `T&S` | 读写台与护眼屏套组 |
| Model | `MaxLite` | Max 基础版 |
| Model | `Max` | Max |
| Model | `Ultra` | Ultra |
| Model | `LF` | 护眼屏独立产品 |
| Screen | `N` | 无屏 |
| Screen | `A` | 友达屏，对应护眼屏 1.0 |
| Screen | `V` | VAVE 屏，对应护眼屏 2.0 |
| Bundle | `N` | 单机 |
| Bundle | `S1` | 套装 1.0 |
| Bundle | `S2` | 套装 2.0 |
| Version | `V1` | 产品版本 1.0 |
| Version | `V2` | 产品版本 2.0 |

## 2. ERP 导入规则

1. Sheet1 第 4–14 行共 11 条有效 SKU 全部导入为草稿；
2. 已提供完整料号的 7 条使用原 `FQT000000AV000` 料号创建 ERP 物料；
3. 仅填写 `FQT` 的 4 条保留为“待补正式料号”，暂用结构化 SKU 编码创建占位物料；
4. 未配置 BOM 前不得批准 SKU；
5. SKU 批准后，结构化编码、ERP 料号、产品名称和渠道规格名均锁定，变更时复制为新 SKU。
