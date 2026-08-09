app_name = "aishike_erp"
app_title = "爱视可 ERP"
app_publisher = "FUTURUS"
app_description = "爱视可智能硬件全生命周期 ERP"
app_email = ""
app_license = "GNU General Public License (v3)"
app_home = "/app/aishike-erp"

required_apps = ["erpnext"]

after_migrate = [
    "aishike_erp.localization.apply_chinese_defaults",
    "aishike_erp.ontology_read.ensure_ontology_reader_role",
    "aishike_erp.sn.ensure_default_rule",
    "aishike_erp.sku_master.ensure_sheet1_skus",
]

doc_events = {
    "User": {
        "validate": "aishike_erp.user_policy.validate_system_user_email_domain",
    }
}
