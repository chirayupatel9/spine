plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

/* The version code is the number of commits, so each release is higher than the last without
   anyone raising it by hand (main only moves forward). The release workflow passes it in as
   VERSION_CODE; elsewhere it's counted here. */
val versionNumber: Int = System.getenv("VERSION_CODE")?.toIntOrNull()
    ?: runCatching { providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }.standardOutput.asText.get().trim().toInt() }
        .getOrDefault(1)

android {
    namespace = "dev.chirayupatel.music"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.chirayupatel.music"   // same as the Play listing: installs as an update
        minSdk = 24
        targetSdk = 36
        versionCode = versionNumber
        versionName = "2.4.$versionNumber"   // raise the first two numbers for bigger changes
    }

    signingConfigs {
        // The release workflow (.github/workflows/android.yml) signs with the upload key from the
        // repository's secrets. Anywhere else the build stays unsigned, and you sign it yourself at
        // jarsigner's and apksigner's prompts (README, "Android app").
        val keystore = System.getenv("ANDROID_KEYSTORE")
        if (!keystore.isNullOrEmpty()) create("upload") {
            storeFile = file(keystore)
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "upload"
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("upload")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.material3:material3")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")

    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-session:1.5.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.5.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("io.coil-kt.coil3:coil-compose:3.0.4")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.0.4")
}
