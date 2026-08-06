from __future__ import annotations

from aishike_erp.rules import build_sku_code


SOURCE_SPREADSHEET = "P003产品SKU规格名称-for产品BOM区分"
SOURCE_SHEET = "Sheet1"


SHEET1_SKUS = (
    {
        "source_row": 4,
        "erp_item_code": "FQT000006AV010",
        "erp_item_code_status": "CONFIRMED",
        "product_name": "P003_Max基础版_无屏",
        "channel_spec_name": "爱视可空间光学读写台【Max基础版】1.0",
        "short_spec_name": "EyesCare Max Lite 1.0",
        "product_line_code": "T",
        "model_code": "MaxLite",
        "screen_code": "N",
        "bundle_code": "N",
        "version_code": "V1",
    },
    {
        "source_row": 5,
        "erp_item_code": "FQT000002AV010",
        "erp_item_code_status": "CONFIRMED",
        "product_name": "P003_Max_无屏",
        "channel_spec_name": "爱视可空间光学读写台【Max】1.0",
        "short_spec_name": "EyesCare Max 1.0",
        "product_line_code": "T",
        "model_code": "Max",
        "screen_code": "N",
        "bundle_code": "N",
        "version_code": "V1",
    },
    {
        "source_row": 6,
        "erp_item_code": "FQT000004AV010",
        "erp_item_code_status": "CONFIRMED",
        "product_name": "P003_Ultra_无屏",
        "channel_spec_name": "爱视可空间光学读写台【Ultra】1.0",
        "short_spec_name": "EyesCare Ultra 1.0",
        "product_line_code": "T",
        "model_code": "Ultra",
        "screen_code": "N",
        "bundle_code": "N",
        "version_code": "V1",
    },
    {
        "source_row": 7,
        "erp_item_code": "FQT",
        "erp_item_code_status": "PENDING",
        "product_name": "P003_护眼屏1",
        "channel_spec_name": "爱视可护眼屏1.0",
        "short_spec_name": "EyesCare LF Display 1.0",
        "product_line_code": "S",
        "model_code": "LF",
        "screen_code": "A",
        "bundle_code": "N",
        "version_code": "V1",
    },
    {
        "source_row": 8,
        "erp_item_code": "FQT",
        "erp_item_code_status": "PENDING",
        "product_name": "P003_Max基础版_护眼屏1",
        "channel_spec_name": "爱视可读写台【Max基础版+护眼屏】套组1.0",
        "short_spec_name": "EyesCare Max Lite+LF Display 1.0",
        "product_line_code": "T&S",
        "model_code": "MaxLite",
        "screen_code": "A",
        "bundle_code": "S1",
        "version_code": "V1",
    },
    {
        "source_row": 9,
        "erp_item_code": "FQT",
        "erp_item_code_status": "PENDING",
        "product_name": "P003_Max_护眼屏1",
        "channel_spec_name": "爱视可读写台【Max+护眼屏】套组1.0",
        "short_spec_name": "EyesCare Max+LF Display 1.0",
        "product_line_code": "T&S",
        "model_code": "Max",
        "screen_code": "A",
        "bundle_code": "S1",
        "version_code": "V1",
    },
    {
        "source_row": 10,
        "erp_item_code": "FQT",
        "erp_item_code_status": "PENDING",
        "product_name": "P003_Ultra_护眼屏1",
        "channel_spec_name": "爱视可读写台【Ultra+护眼屏】套组1.0",
        "short_spec_name": "EyesCare Ultra+LF Display 1.0",
        "product_line_code": "T&S",
        "model_code": "Ultra",
        "screen_code": "A",
        "bundle_code": "S1",
        "version_code": "V1",
    },
    {
        "source_row": 11,
        "erp_item_code": "FQT000005AV010",
        "erp_item_code_status": "CONFIRMED",
        "product_name": "P003_护眼屏2",
        "channel_spec_name": "爱视可护眼屏2.0",
        "short_spec_name": "EyesCare LF Display 2.0",
        "product_line_code": "S",
        "model_code": "LF",
        "screen_code": "V",
        "bundle_code": "N",
        "version_code": "V2",
    },
    {
        "source_row": 12,
        "erp_item_code": "FQT000007AV010",
        "erp_item_code_status": "CONFIRMED",
        "product_name": "P003_Max基础版_护眼屏2",
        "channel_spec_name": "爱视可读写台【Max基础版+护眼屏】套组2.0",
        "short_spec_name": "EyesCare Max Lite+LF Display 2.0",
        "product_line_code": "T&S",
        "model_code": "MaxLite",
        "screen_code": "V",
        "bundle_code": "S2",
        "version_code": "V2",
    },
    {
        "source_row": 13,
        "erp_item_code": "FQT000001AV010",
        "erp_item_code_status": "CONFIRMED",
        "product_name": "P003_Max_护眼屏2",
        "channel_spec_name": "爱视可读写台【Max+护眼屏】套组2.0",
        "short_spec_name": "EyesCare Max+LF Display 2.0",
        "product_line_code": "T&S",
        "model_code": "Max",
        "screen_code": "V",
        "bundle_code": "S2",
        "version_code": "V2",
    },
    {
        "source_row": 14,
        "erp_item_code": "FQT000003AV010",
        "erp_item_code_status": "CONFIRMED",
        "product_name": "P003_Ultra_护眼屏2",
        "channel_spec_name": "爱视可读写台【Ultra+护眼屏】套组2.0",
        "short_spec_name": "EyesCare Ultra+LF Display 2.0",
        "product_line_code": "T&S",
        "model_code": "Ultra",
        "screen_code": "V",
        "bundle_code": "S2",
        "version_code": "V2",
    },
)


def sheet1_skus() -> tuple[dict[str, object], ...]:
    rows = []
    for source in SHEET1_SKUS:
        row = dict(source)
        row["item_code"] = build_sku_code(
            str(row["product_line_code"]),
            str(row["model_code"]),
            str(row["screen_code"]),
            str(row["bundle_code"]),
            str(row["version_code"]),
        )
        row["source_reference"] = (
            f"{SOURCE_SPREADSHEET}/{SOURCE_SHEET}/row-{row['source_row']}"
        )
        rows.append(row)
    return tuple(rows)
