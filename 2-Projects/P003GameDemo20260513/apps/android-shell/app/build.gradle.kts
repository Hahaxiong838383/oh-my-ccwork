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

        // sherpa-onnx 端侧唤醒词：纯离线、无账号、无激活，模型在 assets/kws-model/。
        // 只打包 arm64-v8a（覆盖现代手机；onnxruntime.so 单 ABI ~26M，全 ABI 会翻几倍）。
        ndk {
            abiFilters += "arm64-v8a"
        }
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
        kotlinCompilerExtensionVersion = "1.5.8"
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

    // 唤醒词引擎 = sherpa-onnx（源码集成，非 maven）：
    //   - Kotlin API 在 java/com/k2fsa/sherpa/onnx/（v1.13.3，22 个 .kt）
    //   - 预编译 native .so 在 jniLibs/arm64-v8a/（libsherpa-onnx-jni + libonnxruntime + c-api）
    //   - AGP 默认自动打包 src/main/jniLibs，无需额外依赖声明

    // Debug 工具
    debugImplementation("androidx.compose.ui:ui-tooling:1.5.4")
    debugImplementation("androidx.compose.ui:ui-test-manifest:1.5.4")
}
