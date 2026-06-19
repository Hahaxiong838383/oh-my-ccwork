plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cc.hahaxiong.kidshub"
    compileSdk = 34

    defaultConfig {
        applicationId = "cc.hahaxiong.kidshub"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // 目标 URL 可配置（默认生产体验台移动端路由）
        // 修改此处可指向局域网开发服务器，例如：
        // "https://192.168.1.100:5173/m"   // 用于 Vite dev server 本地联调
        buildConfigField("String", "WEBVIEW_URL", "\"https://kidshub-ai.hahaxiong.cc/m\"")

        // Porcupine AccessKey（占位）
        // TODO: 去 https://console.picovoice.ai/ 注册获取 AccessKey，填入下方
        // 注意：国内访问 Picovoice Console 可能需要科学上网，首次初始化需要联网校验
        buildConfigField("String", "PORCUPINE_ACCESS_KEY", "\"\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            // debug 下可放行自签名证书（见 MainActivity WebViewClient）
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.4"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.activity:activity-compose:1.8.2")

    // Jetpack Compose
    implementation("androidx.compose.ui:ui:1.5.4")
    implementation("androidx.compose.ui:ui-graphics:1.5.4")
    implementation("androidx.compose.ui:ui-tooling-preview:1.5.4")
    implementation("androidx.compose.material3:material3:1.1.2")

    // WebView（标准 WebView + 必要配置）
    // androidx.webkit 可选，这里直接用 android.webkit.WebView 即可

    // Picovoice Porcupine Android SDK（前台唤醒词）
    // 版本按官方 3.x 系列
    implementation("ai.picovoice:porcupine-android:3.+")

    // Debug 工具
    debugImplementation("androidx.compose.ui:ui-tooling:1.5.4")
    debugImplementation("androidx.compose.ui:ui-test-manifest:1.5.4")
}
