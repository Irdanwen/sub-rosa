plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "xyz.carpediem.subrosa.nativebridge"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
}
