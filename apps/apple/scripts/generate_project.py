#!/usr/bin/env python3
"""Write apps/apple/Veil.xcodeproj. Run from the repository root or this directory."""
from __future__ import annotations

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJ = ROOT / "Veil.xcodeproj"

APP = "A10000000000000000000002"
TESTS = "A10000000000000000000003"
UITESTS = "A10000000000000000000004"
PROJECT = "A10000000000000000000001"


def hid(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:24].upper()


def file_ref(path: Path) -> str:
    return hid("ref:" + str(path.relative_to(ROOT)))


def build_ref(path: Path, phase: str) -> str:
    return hid(f"build:{phase}:{path.relative_to(ROOT)}")


def quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def quote_key(key: str) -> str:
    if key.replace("_", "").isalnum():
        return key
    return quote(key)


def settings_block(settings: dict, indent: str = "\t\t\t") -> str:
    lines = []
    for key in settings:
        value = settings[key]
        if isinstance(value, list):
            inner = ",\n".join(f"{indent}\t{quote(item)}" for item in value)
            lines.append(f"{indent}{quote_key(key)} = (\n{inner},\n{indent});")
        else:
            lines.append(f"{indent}{quote_key(key)} = {quote(str(value))};")
    return "\n".join(lines)


def collect(folder: str, suffix: str) -> list[Path]:
    base = ROOT / folder
    return sorted(path for path in base.rglob(f"*{suffix}") if path.is_file())


def main() -> None:
    swift_app = collect("Veil", ".swift")
    swift_tests = collect("VeilTests", ".swift")
    swift_ui = collect("VeilUITests", ".swift")
    resources = [
        ROOT / "Veil" / "Assets.xcassets",
        ROOT / "Veil" / "Resources" / "registry.json",
        ROOT / "Veil" / "PrivacyInfo.xcprivacy",
    ]
    info = ROOT / "Veil" / "Info.plist"
    for path in resources + [info] + swift_app + swift_tests + swift_ui:
        if not path.exists():
            raise SystemExit(f"missing {path}")

    def filetype(path: Path) -> str:
        if path.suffix == ".swift":
            return "sourcecode.swift"
        if path.suffix == ".json":
            return "text.json"
        if path.suffix == ".plist":
            return "text.plist.xml"
        if path.name.endswith(".xcprivacy"):
            return "text.plist.xml"
        if path.suffix == ".xcassets":
            return "folder.assetcatalog"
        raise SystemExit(path)

    files = swift_app + swift_tests + swift_ui + resources + [info]
    file_refs = []
    for path in files:
        file_refs.append(
            f"\t\t{file_ref(path)} /* {path.name} */ = {{isa = PBXFileReference; lastKnownFileType = {filetype(path)}; path = {path.name}; sourceTree = \"<group>\"; }};"
        )
    file_refs.append(
        f'\t\t{hid("product-app")} /* VEIL.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = VEIL.app; sourceTree = BUILT_PRODUCTS_DIR; }};'
    )
    file_refs.append(
        f'\t\t{hid("product-tests")} /* VeilTests.xctest */ = {{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = VeilTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; }};'
    )
    file_refs.append(
        f'\t\t{hid("product-ui")} /* VeilUITests.xctest */ = {{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = VeilUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR; }};'
    )

    def build_files(paths: list[Path], phase: str) -> str:
        return "\n".join(
            f"\t\t{build_ref(path, phase)} /* {path.name} in {phase} */ = {{isa = PBXBuildFile; fileRef = {file_ref(path)} /* {path.name} */; }};"
            for path in paths
        )

    def phase(phase_id: str, isa: str, paths: list[Path], phase_name: str) -> str:
        body = "\n".join(f"\t\t\t\t{build_ref(path, phase_name)} /* {path.name} in {phase_name} */," for path in paths)
        return (
            f"\t\t{phase_id} /* {phase_name} */ = {{\n"
            f"\t\t\tisa = {isa};\n"
            f"\t\t\tbuildActionMask = 2147483647;\n"
            f"\t\t\tfiles = (\n{body}\n\t\t\t);\n"
            f"\t\t\trunOnlyForDeploymentPostprocessing = 0;\n"
            f"\t\t}};"
        )

    def children(paths: list[Path]) -> str:
        return "\n".join(f"\t\t\t\t{file_ref(path)} /* {path.name} */," for path in paths)

    app_sources = hid("phase-app-sources")
    app_resources = hid("phase-app-resources")
    app_frameworks = hid("phase-app-frameworks")
    test_sources = hid("phase-test-sources")
    test_frameworks = hid("phase-test-frameworks")
    ui_sources = hid("phase-ui-sources")
    ui_frameworks = hid("phase-ui-frameworks")

    group_app = hid("group-app")
    group_resources = hid("group-resources")
    group_tests = hid("group-tests")
    group_ui = hid("group-ui")
    group_products = hid("group-products")
    group_main = hid("group-main")

    proxy_tests = hid("proxy-tests")
    proxy_ui = hid("proxy-ui")
    dep_tests = hid("dep-tests")
    dep_ui = hid("dep-ui")

    debug_project = hid("cfg-debug-project")
    release_project = hid("cfg-release-project")
    debug_app = hid("cfg-debug-app")
    release_app = hid("cfg-release-app")
    debug_tests = hid("cfg-debug-tests")
    release_tests = hid("cfg-release-tests")
    debug_ui = hid("cfg-debug-ui")
    release_ui = hid("cfg-release-ui")
    list_project = hid("list-project")
    list_app = hid("list-app")
    list_tests = hid("list-tests")
    list_ui = hid("list-ui")

    shared = {
        "ALWAYS_SEARCH_USER_PATHS": "NO",
        "CLANG_ENABLE_MODULES": "YES",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "COPY_PHASE_STRIP": "NO",
        "DEBUG_INFORMATION_FORMAT": "dwarf",
        "ENABLE_STRICT_OBJC_MSGSEND": "YES",
        "GCC_C_LANGUAGE_STANDARD": "gnu11",
        "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "ONLY_ACTIVE_ARCH": "YES",
        "SDKROOT": "auto",
        "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator macosx",
        "SUPPORTS_MACCATALYST": "NO",
        "SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD": "NO",
        "SWIFT_VERSION": "5.0",
        "ENABLE_TESTABILITY": "YES",
        "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG",
        "SWIFT_OPTIMIZATION_LEVEL": "-Onone",
    }
    release_shared = {
        **shared,
        "DEBUG_INFORMATION_FORMAT": "dwarf-with-dsym",
        "ENABLE_NS_ASSERTIONS": "NO",
        "SWIFT_COMPILATION_MODE": "wholemodule",
        "SWIFT_OPTIMIZATION_LEVEL": "-O",
        "VALIDATE_PRODUCT": "YES",
    }
    release_shared.pop("SWIFT_ACTIVE_COMPILATION_CONDITIONS", None)

    app_settings = {
        "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
        "CODE_SIGN_IDENTITY": "",
        "CODE_SIGN_STYLE": "Manual",
        "CODE_SIGNING_ALLOWED": "NO",
        "CODE_SIGNING_REQUIRED": "NO",
        "CURRENT_PROJECT_VERSION": "1",
        "ENABLE_DEBUG_DYLIB": "NO",
        "GENERATE_INFOPLIST_FILE": "NO",
        "INFOPLIST_FILE": "Veil/Info.plist",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"],
        "LD_RUNPATH_SEARCH_PATHS[sdk=macosx*]": ["$(inherited)", "@executable_path/../Frameworks"],
        "MARKETING_VERSION": "1.0",
        "PRODUCT_BUNDLE_IDENTIFIER": "app.infinitumveil.browser",
        "PRODUCT_MODULE_NAME": "Veil",
        "PRODUCT_NAME": "VEIL",
        "TARGETED_DEVICE_FAMILY": "1,2",
    }
    test_common = {
        "CODE_SIGN_IDENTITY": "",
        "CODE_SIGN_STYLE": "Manual",
        "CODE_SIGNING_ALLOWED": "NO",
        "CODE_SIGNING_REQUIRED": "NO",
        "CURRENT_PROJECT_VERSION": "1",
        "GENERATE_INFOPLIST_FILE": "YES",
        "MARKETING_VERSION": "1.0",
        "SDKROOT": "auto",
        "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator macosx",
        "SWIFT_VERSION": "5.0",
        "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks", "@loader_path/Frameworks"],
        "LD_RUNPATH_SEARCH_PATHS[sdk=macosx*]": ["$(inherited)", "@executable_path/../Frameworks", "@loader_path/../Frameworks"],
    }
    unit_settings = {
        **test_common,
        "BUNDLE_LOADER": "$(TEST_HOST)",
        "PRODUCT_BUNDLE_IDENTIFIER": "app.infinitumveil.browser.tests",
        "PRODUCT_MODULE_NAME": "VeilTests",
        "PRODUCT_NAME": "VeilTests",
        "TEST_HOST": "$(BUILT_PRODUCTS_DIR)/VEIL.app/VEIL",
        "TEST_HOST[sdk=macosx*]": "$(BUILT_PRODUCTS_DIR)/VEIL.app/Contents/MacOS/VEIL",
        "TEST_HOST[sdk=iphoneos*]": "$(BUILT_PRODUCTS_DIR)/VEIL.app/VEIL",
        "TEST_HOST[sdk=iphonesimulator*]": "$(BUILT_PRODUCTS_DIR)/VEIL.app/VEIL",
    }
    ui_settings = {
        **test_common,
        "PRODUCT_BUNDLE_IDENTIFIER": "app.infinitumveil.browser.uitests",
        "PRODUCT_MODULE_NAME": "VeilUITests",
        "PRODUCT_NAME": "VeilUITests",
        "TEST_TARGET_NAME": "Veil",
    }

    def config(cid: str, name: str, base: dict) -> str:
        return (
            f"\t\t{cid} /* {name} */ = {{\n"
            f"\t\t\tisa = XCBuildConfiguration;\n"
            f"\t\t\tbuildSettings = {{\n{settings_block(base)}\n\t\t\t}};\n"
            f"\t\t\tname = {name};\n"
            f"\t\t}};"
        )

    def config_list(lid: str, debug: str, release: str) -> str:
        return (
            f"\t\t{lid} /* Build configuration list */ = {{\n"
            f"\t\t\tisa = XCConfigurationList;\n"
            f"\t\t\tbuildConfigurations = (\n\t\t\t\t{debug} /* Debug */,\n\t\t\t\t{release} /* Release */,\n\t\t\t);\n"
            f"\t\t\tdefaultConfigurationIsVisible = 0;\n"
            f"\t\t\tdefaultConfigurationName = Release;\n"
            f"\t\t}};"
        )

    def target(tid: str, name: str, product_name: str, product_ref: str, product_type: str, phases: list[str], deps: list[str], configs: str) -> str:
        phase_body = "\n".join(f"\t\t\t\t{phase}," for phase in phases)
        dep_body = "\n".join(f"\t\t\t\t{dep} /* PBXTargetDependency */," for dep in deps)
        return f"""\t\t{tid} /* {name} */ = {{
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = {configs} /* Build configuration list */;
\t\t\tbuildPhases = (
{phase_body}
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
{dep_body}
\t\t\t);
\t\t\tname = {name};
\t\t\tproductName = {name};
\t\t\tproductReference = {product_ref} /* {product_name} */;
\t\t\tproductType = "{product_type}";
\t\t}};"""

    pbx = f"""// !$*UTF8*$!
{{
\tarchiveVersion = 1;
\tclasses = {{
\t}};
\tobjectVersion = 56;
\tobjects = {{

/* Begin PBXBuildFile section */
{build_files(swift_app, "Sources")}
{build_files(resources, "Resources")}
{build_files(swift_tests, "Sources")}
{build_files(swift_ui, "Sources")}
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
\t\t{proxy_tests} /* PBXContainerItemProxy */ = {{
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = {PROJECT} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = {APP};
\t\t\tremoteInfo = Veil;
\t\t}};
\t\t{proxy_ui} /* PBXContainerItemProxy */ = {{
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = {PROJECT} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = {APP};
\t\t\tremoteInfo = Veil;
\t\t}};
/* End PBXContainerItemProxy section */

/* Begin PBXFileReference section */
{chr(10).join(file_refs)}
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t{app_frameworks} /* Frameworks */ = {{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; }};
\t\t{test_frameworks} /* Frameworks */ = {{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; }};
\t\t{ui_frameworks} /* Frameworks */ = {{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; }};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t{group_resources} /* Resources */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t{file_ref(ROOT / "Veil" / "Resources" / "registry.json")} /* registry.json */,
\t\t\t);
\t\t\tpath = Resources;
\t\t\tsourceTree = "<group>";
\t\t}};
\t\t{group_app} /* Veil */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
{children([path for path in swift_app])}
\t\t\t\t{file_ref(ROOT / "Veil" / "Assets.xcassets")} /* Assets.xcassets */,
\t\t\t\t{file_ref(info)} /* Info.plist */,
\t\t\t\t{file_ref(ROOT / "Veil" / "PrivacyInfo.xcprivacy")} /* PrivacyInfo.xcprivacy */,
\t\t\t\t{group_resources} /* Resources */,
\t\t\t);
\t\t\tpath = Veil;
\t\t\tsourceTree = "<group>";
\t\t}};
\t\t{group_tests} /* VeilTests */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
{children(swift_tests)}
\t\t\t);
\t\t\tpath = VeilTests;
\t\t\tsourceTree = "<group>";
\t\t}};
\t\t{group_ui} /* VeilUITests */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
{children(swift_ui)}
\t\t\t);
\t\t\tpath = VeilUITests;
\t\t\tsourceTree = "<group>";
\t\t}};
\t\t{group_products} /* Products */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t{hid("product-app")} /* VEIL.app */,
\t\t\t\t{hid("product-tests")} /* VeilTests.xctest */,
\t\t\t\t{hid("product-ui")} /* VeilUITests.xctest */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t}};
\t\t{group_main} = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t{group_app} /* Veil */,
\t\t\t\t{group_tests} /* VeilTests */,
\t\t\t\t{group_ui} /* VeilUITests */,
\t\t\t\t{group_products} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t}};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
{target(APP, "Veil", "VEIL.app", hid("product-app"), "com.apple.product-type.application", [app_sources, app_frameworks, app_resources], [], list_app)}
{target(TESTS, "VeilTests", "VeilTests.xctest", hid("product-tests"), "com.apple.product-type.bundle.unit-test", [test_sources, test_frameworks], [dep_tests], list_tests)}
{target(UITESTS, "VeilUITests", "VeilUITests.xctest", hid("product-ui"), "com.apple.product-type.bundle.ui-testing", [ui_sources, ui_frameworks], [dep_ui], list_ui)}
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t{PROJECT} /* Project object */ = {{
\t\t\tisa = PBXProject;
\t\t\tattributes = {{
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 1500;
\t\t\t\tLastUpgradeCheck = 1500;
\t\t\t\tTargetAttributes = {{
\t\t\t\t\t{APP} = {{ CreatedOnToolsVersion = 15.0; }};
\t\t\t\t\t{TESTS} = {{ CreatedOnToolsVersion = 15.0; TestTargetID = {APP}; }};
\t\t\t\t\t{UITESTS} = {{ CreatedOnToolsVersion = 15.0; TestTargetID = {APP}; }};
\t\t\t\t}};
\t\t\t}};
\t\t\tbuildConfigurationList = {list_project} /* Build configuration list */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (en, Base);
\t\t\tmainGroup = {group_main};
\t\t\tproductRefGroup = {group_products} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t{APP} /* Veil */,
\t\t\t\t{TESTS} /* VeilTests */,
\t\t\t\t{UITESTS} /* VeilUITests */,
\t\t\t);
\t\t}};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
{phase(app_resources, "PBXResourcesBuildPhase", resources, "Resources")}
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
{phase(app_sources, "PBXSourcesBuildPhase", swift_app, "Sources")}
{phase(test_sources, "PBXSourcesBuildPhase", swift_tests, "Sources")}
{phase(ui_sources, "PBXSourcesBuildPhase", swift_ui, "Sources")}
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
\t\t{dep_tests} /* PBXTargetDependency */ = {{
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = {APP} /* Veil */;
\t\t\ttargetProxy = {proxy_tests} /* PBXContainerItemProxy */;
\t\t}};
\t\t{dep_ui} /* PBXTargetDependency */ = {{
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = {APP} /* Veil */;
\t\t\ttargetProxy = {proxy_ui} /* PBXContainerItemProxy */;
\t\t}};
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
{config(debug_project, "Debug", shared)}
{config(release_project, "Release", release_shared)}
{config(debug_app, "Debug", app_settings)}
{config(release_app, "Release", app_settings)}
{config(debug_tests, "Debug", unit_settings)}
{config(release_tests, "Release", unit_settings)}
{config(debug_ui, "Debug", ui_settings)}
{config(release_ui, "Release", ui_settings)}
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
{config_list(list_project, debug_project, release_project)}
{config_list(list_app, debug_app, release_app)}
{config_list(list_tests, debug_tests, release_tests)}
{config_list(list_ui, debug_ui, release_ui)}
/* End XCConfigurationList section */
\t}};
\trootObject = {PROJECT} /* Project object */;
}}
"""
    # The resources phase name collides with the Sources phase name "Sources" for build ids.
    # build_ref includes the phase argument passed to build_files, which is "Resources" or "Sources".
    # phase() looks up build_ref(path, phase_name). Those match. Good.

    project_dir = PROJ
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "project.pbxproj").write_text(pbx, encoding="utf-8")
    scheme_dir = project_dir / "xcshareddata" / "xcschemes"
    scheme_dir.mkdir(parents=True, exist_ok=True)
    (scheme_dir / "Veil.xcscheme").write_text(scheme(APP, TESTS, UITESTS), encoding="utf-8")
    print(f"wrote {project_dir / 'project.pbxproj'}")


def scheme(app: str, tests: str, ui: str) -> str:
    def ref(blueprint: str, name: str, product: str) -> str:
        return f"""               <BuildableReference
                  BuildableIdentifier = "primary"
                  BlueprintIdentifier = "{blueprint}"
                  BuildableName = "{product}"
                  BlueprintName = "{name}"
                  ReferencedContainer = "container:Veil.xcodeproj">
               </BuildableReference>"""

    def entry(blueprint: str, name: str, product: str, testing: bool, running: bool) -> str:
        return f"""         <BuildActionEntry
            buildForTesting = "{'YES' if testing else 'NO'}"
            buildForRunning = "{'YES' if running else 'NO'}"
            buildForProfiling = "NO"
            buildForArchiving = "{'YES' if running else 'NO'}"
            buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "{blueprint}"
               BuildableName = "{product}"
               BlueprintName = "{name}"
               ReferencedContainer = "container:Veil.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>"""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1500"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
{entry(app, "Veil", "VEIL.app", True, True)}
{entry(tests, "VeilTests", "VeilTests.xctest", True, False)}
{entry(ui, "VeilUITests", "VeilUITests.xctest", True, False)}
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference
            skipped = "NO">
{ref(tests, "VeilTests", "VeilTests.xctest")}
         </TestableReference>
         <TestableReference
            skipped = "NO">
{ref(ui, "VeilUITests", "VeilUITests.xctest")}
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
{ref(app, "Veil", "VEIL.app")}
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
{ref(app, "Veil", "VEIL.app")}
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
"""


if __name__ == "__main__":
    main()
