import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Ключ подписи лежит вне репозитория: keystore.properties рядом с этим
// проектом (storeFile, storePassword, keyAlias, keyPassword). Без него
// release подписывается debug-ключом — APK ставится, но обновлять его
// поверх потом можно только тем же ключом.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "lat.boltmusic.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "lat.boltmusic.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 6
        versionName = "1.5"
        buildConfigField("String", "START_URL", "\"https://boltmusic.lat/\"")
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.media:media:1.7.0")
}
