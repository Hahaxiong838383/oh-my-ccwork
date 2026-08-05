app_name = "aishike_erp"
app_title = "爱视可 ERP"
app_publisher = "FUTURUS"
app_description = "爱视可智能硬件全生命周期 ERP"
app_email = ""
app_license = "GNU General Public License (v3)"
app_home = "/app/aishike-erp"

required_apps = ["erpnext"]

after_migrate = ["aishike_erp.localization.apply_chinese_defaults"]
