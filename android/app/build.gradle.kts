plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.arunperiyal.tex2htmlviewer"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.arunperiyal.tex2htmlviewer"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    // Release signing: the key stays outside the repo. Its location and
    // passwords come from Gradle properties (~/.gradle/gradle.properties, or
    // ORG_GRADLE_PROJECT_t2hv_... in the environment); without them the
    // release APK is built unsigned.
    val signing = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
        .associateWith { providers.gradleProperty("t2hv.$it").orNull }
    signingConfigs {
        if (signing.values.all { it != null }) create("release") {
            storeFile = file(signing.getValue("storeFile")!!)
            storePassword = signing.getValue("storePassword")
            keyAlias = signing.getValue("keyAlias")
            keyPassword = signing.getValue("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.webkit:webkit:1.17.1")
}

// ---------------------------------------------------------------- the web app
// The viewer's screens are the web app (../web), built with base "/" and
// bundled into the APK's assets under web/; MainActivity serves them under
// https://appassets.androidplatform.net/.

val webDir = rootDir.resolve("../web")

val buildWeb = tasks.register<Exec>("buildWeb") {
    workingDir = webDir
    environment("BASE", "/")
    commandLine("npm", "run", "build")
    inputs.dir(webDir.resolve("src"))
    inputs.dir(webDir.resolve("public"))
    inputs.file(webDir.resolve("index.html"))
    inputs.file(webDir.resolve("vite.config.ts"))
    outputs.dir(webDir.resolve("dist"))
}

abstract class CopyWeb : DefaultTask() {
    @get:InputDirectory abstract val dist: DirectoryProperty
    @get:OutputDirectory abstract val assets: DirectoryProperty

    @TaskAction fun copy() {
        val out = assets.get().asFile
        out.deleteRecursively()
        dist.get().asFile.copyRecursively(out.resolve("web"))
    }
}

val copyWeb = tasks.register<CopyWeb>("copyWeb") {
    dependsOn(buildWeb)
    dist.set(webDir.resolve("dist"))
    assets.set(layout.buildDirectory.dir("generated/webAssets"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyWeb, CopyWeb::assets)
    }
}
