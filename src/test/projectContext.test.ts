import * as assert from 'assert';
import {
    parseSolutionProjects,
    languageFromExt,
    extractProjectFacts,
    applyBudget,
    parseProjectMetadata,
    ProjectDescription,
    renderSolutionMap,
    isProbableEntryPoint,
    renderWorkspaceOverview,
    KNOWLEDGE_DOC_TEMPLATE
} from '../projectContext';

suite('projectContext: knowledge document template', () => {
    test('prompts for essential domain, architecture, operations, and evidence', () => {
        const headings = [
            'Purpose and users',
            'Domain glossary',
            'Architecture',
            'Component responsibilities',
            'Key runtime flows',
            'Projects and entry points',
            'Invariants and constraints',
            'Configuration and deployment',
            'Build, test, and debug commands',
            'Ownership boundaries',
            'Conventions',
            'Known hazards',
            'Authoritative source paths'
        ];

        for (const heading of headings) {
            assert.match(KNOWLEDGE_DOC_TEMPLATE, new RegExp(`^## ${heading}$`, 'm'), heading);
        }
    });

    test('asks for verified workspace-relative evidence without inventing product facts', () => {
        assert.match(KNOWLEDGE_DOC_TEMPLATE, /workspace-relative paths/);
        assert.match(KNOWLEDGE_DOC_TEMPLATE, /Write "Unknown"/);
        assert.match(KNOWLEDGE_DOC_TEMPLATE, /do not speculate/);
        assert.match(KNOWLEDGE_DOC_TEMPLATE, /Never include secrets/);
        assert.doesNotMatch(KNOWLEDGE_DOC_TEMPLATE, /Starfish|radio-gateway|Parraid/i);
    });
});

suite('projectContext: parseSolutionProjects', () => {
    test('extracts C# and C++ projects, skips solution folders', () => {
        const sln = [
            'Microsoft Visual Studio Solution File, Format Version 12.00',
            'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{111}"',
            'EndProject',
            'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Native", "native\\Native.vcxproj", "{222}"',
            'EndProject',
            'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Solution Items", "Solution Items", "{333}"',
            'EndProject'
        ].join('\n');
        const projects = parseSolutionProjects(sln);
        assert.strictEqual(projects.length, 2);
        assert.deepStrictEqual(projects[0], { name: 'App', relPath: 'src\\App\\App.csproj' });
        assert.deepStrictEqual(projects[1], { name: 'Native', relPath: 'native\\Native.vcxproj' });
    });

    test('returns empty array when there are no project entries', () => {
        assert.deepStrictEqual(parseSolutionProjects('Microsoft Visual Studio Solution File'), []);
    });
});

suite('projectContext: languageFromExt', () => {
    test('maps known extensions', () => {
        assert.strictEqual(languageFromExt('a.csproj'), 'C#');
        assert.strictEqual(languageFromExt('a.vcxproj'), 'C++');
        assert.strictEqual(languageFromExt('a.vbproj'), 'VB');
        assert.strictEqual(languageFromExt('a.fsproj'), 'F#');
    });

    test('falls back for unknown extensions', () => {
        assert.strictEqual(languageFromExt('a.zzproj'), 'project');
    });
});

suite('projectContext: extractProjectFacts', () => {
    test('reads TargetFramework and OutputType from a .csproj', () => {
        const proj = '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup></Project>';
        assert.deepStrictEqual(extractProjectFacts(proj, 'App.csproj'), ['net8.0', 'Exe']);
    });

    test('reads legacy TargetFrameworkVersion', () => {
        const proj = '<Project><PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>';
        assert.deepStrictEqual(extractProjectFacts(proj, 'Legacy.csproj'), ['v4.8']);
    });

    test('reads ConfigurationType and PlatformToolset from a .vcxproj', () => {
        const proj = '<Project><PropertyGroup><ConfigurationType>DynamicLibrary</ConfigurationType><PlatformToolset>v143</PlatformToolset></PropertyGroup></Project>';
        assert.deepStrictEqual(extractProjectFacts(proj, 'Native.vcxproj'), ['DynamicLibrary', 'v143']);
    });

    test('returns empty array when nothing matches', () => {
        assert.deepStrictEqual(extractProjectFacts('<Project></Project>', 'Empty.csproj'), []);
    });
});

suite('projectContext: semantic metadata', () => {
    test('parses SDK-style multi-target project metadata and deduplicates conditioned values', () => {
        const project = `<Project Sdk="Microsoft.NET.Sdk">
            <PropertyGroup><TargetFrameworks>net8.0;net9.0</TargetFrameworks><OutputType>Exe</OutputType><AssemblyName>Gateway</AssemblyName><RootNamespace>Parraid.Gateway</RootNamespace></PropertyGroup>
            <PropertyGroup Condition="'$(Configuration)' == 'Debug'"><OutputType>Exe</OutputType></PropertyGroup>
            <ItemGroup><ProjectReference Include="..\\Core\\Core.csproj"/><PackageReference Include="Serilog" Version="4.0"/><PackageReference Include="Serilog" Version="4.0"/></ItemGroup>
        </Project>`;
        const metadata = parseProjectMetadata(project, 'Gateway/Gateway.csproj');

        assert.deepStrictEqual(metadata.targets, ['net8.0', 'net9.0']);
        assert.deepStrictEqual(metadata.outputTypes, ['Exe']);
        assert.deepStrictEqual(metadata.assemblyNames, ['Gateway']);
        assert.deepStrictEqual(metadata.rootNamespaces, ['Parraid.Gateway']);
        assert.deepStrictEqual(metadata.projectReferences, ['..\\Core\\Core.csproj']);
        assert.deepStrictEqual(metadata.packages, ['Serilog']);
        assert.strictEqual(metadata.kind, 'executable');
    });

    test('classifies explicit and package-based test projects', () => {
        const explicit = parseProjectMetadata('<Project><IsTestProject>true</IsTestProject></Project>', 'Tests.csproj');
        const packageBased = parseProjectMetadata('<Project><PackageReference Include="Microsoft.NET.Test.Sdk" /></Project>', 'Checks.csproj');
        assert.strictEqual(explicit.kind, 'test');
        assert.strictEqual(packageBased.kind, 'test');
    });

    test('parses C++ references and native dependencies', () => {
        const project = `<Project><PropertyGroup><ConfigurationType>DynamicLibrary</ConfigurationType><PlatformToolset>v143</PlatformToolset><RootNamespace>RadioNative</RootNamespace></PropertyGroup>
            <ItemGroup><ProjectReference Include="..\\Codec\\Codec.vcxproj" /></ItemGroup>
            <ItemDefinitionGroup><Link><AdditionalDependencies>ws2_32.lib;crypt32.lib;%(AdditionalDependencies)</AdditionalDependencies></Link></ItemDefinitionGroup></Project>`;
        const metadata = parseProjectMetadata(project, 'Native/Radio.vcxproj');

        assert.strictEqual(metadata.kind, 'library');
        assert.deepStrictEqual(metadata.projectReferences, ['..\\Codec\\Codec.vcxproj']);
        assert.deepStrictEqual(metadata.additionalDependencies, ['crypt32.lib', 'ws2_32.lib']);
    });

    test('classifies shared and unknown projects conservatively', () => {
        assert.strictEqual(parseProjectMetadata('<Project />', 'Common.shproj').kind, 'shared');
        assert.strictEqual(parseProjectMetadata('<Project />', 'Core.csproj').kind, 'unknown');
    });
});

suite('projectContext: semantic map rendering', () => {
    function project(overrides: Partial<ProjectDescription>): ProjectDescription {
        return {
            name: 'Core',
            relPath: 'Core/Core.csproj',
            path: 'Core/Core.csproj',
            language: 'C#',
            targets: ['net8.0'],
            outputTypes: ['Library'],
            assemblyNames: [],
            rootNamespaces: [],
            configurationTypes: [],
            platformToolsets: [],
            projectReferences: [],
            packages: [],
            additionalDependencies: [],
            kind: 'library',
            entryPoints: [],
            readable: true,
            ...overrides
        };
    }

    test('sorts projects and resolves project-reference dependency edges', () => {
        const rendered = renderSolutionMap('Starfish.sln', [
            project({
                name: 'Gateway',
                relPath: 'Gateway/Gateway.csproj',
                path: 'Gateway/Gateway.csproj',
                kind: 'executable',
                outputTypes: ['Exe'],
                projectReferences: ['..\\Core\\Core.csproj', '..\\Missing\\Missing.csproj'],
                packages: ['Serilog'],
                entryPoints: ['Program.cs']
            }),
            project({})
        ]);

        assert.ok(rendered.indexOf('Project: Core') < rendered.indexOf('Project: Gateway'));
        assert.match(rendered, /References: \.\.\/Missing\/Missing\.csproj, Core/);
        assert.match(rendered, /Probable entry points: Program\.cs/);
        assert.match(rendered, /Dependency edges:\nGateway -> \.\.\/Missing\/Missing\.csproj\nGateway -> Core/);
    });

    test('reports unreadable project files with their source path', () => {
        const rendered = renderSolutionMap('Broken.sln', [project({ readable: false })]);
        assert.match(rendered, /Path: Core\/Core\.csproj/);
        assert.match(rendered, /Status: project file unreadable/);
    });
});

suite('projectContext: probable entry points', () => {
    test('recognizes conventional managed and native filenames', () => {
        assert.strictEqual(isProbableEntryPoint('Program.cs'), true);
        assert.strictEqual(isProbableEntryPoint('main.cpp'), true);
        assert.strictEqual(isProbableEntryPoint('App.xaml'), true);
    });

    test('recognizes C++ entry functions in nonstandard filenames', () => {
        assert.strictEqual(isProbableEntryPoint('bootstrap.cpp', 'int WinMain(void) { return 0; }'), true);
        assert.strictEqual(isProbableEntryPoint('startup.cc', 'int main(int argc, char** argv) {}'), true);
        assert.strictEqual(isProbableEntryPoint('library.cpp', 'void initialize() {}'), false);
    });
});

suite('projectContext: no-solution workspace overview', () => {
    test('summarizes a TypeScript workspace and parses package scripts', () => {
        const rendered = renderWorkspaceOverview({
            files: ['package.json', 'README.md', 'src/index.ts', 'src/service.ts', 'tests/service.test.ts'],
            directories: ['src', 'tests'],
            packageJson: {
                'package.json': JSON.stringify({ scripts: { test: 'mocha', build: 'tsc' } })
            },
            truncated: false
        });

        assert.match(rendered, /Manifests\/build files: package\.json, README\.md/);
        assert.match(rendered, /Source roots: src/);
        assert.match(rendered, /Test roots: tests/);
        assert.match(rendered, /Languages: TypeScript \(3\)/);
        assert.match(rendered, /Probable entry points: src\/index\.ts/);
        assert.match(rendered, /Package scripts:\n- package\.json: build, test/);
    });

    test('summarizes a CMake C++ workspace', () => {
        const rendered = renderWorkspaceOverview({
            files: ['CMakeLists.txt', 'README', 'source/main.cpp', 'source/radio.cpp'],
            directories: ['source'],
            packageJson: {},
            truncated: false
        });

        assert.match(rendered, /Manifests\/build files: CMakeLists\.txt, README/);
        assert.match(rendered, /Source roots: source/);
        assert.match(rendered, /Languages: C\+\+ \(2\)/);
        assert.match(rendered, /Probable entry points: source\/main\.cpp/);
    });

    test('reports an empty workspace clearly', () => {
        const rendered = renderWorkspaceOverview({
            files: [], directories: [], packageJson: {}, truncated: false
        });
        assert.match(rendered, /Workspace is empty or unreadable/);
    });

    test('excludes dependency and generated directories from every summary', () => {
        const rendered = renderWorkspaceOverview({
            files: [
                'src/index.ts', 'node_modules/pkg/index.ts', 'dist/main.js',
                'build/CMakeLists.txt', 'target/main.rs'
            ],
            directories: ['src', 'node_modules', 'node_modules/pkg', 'dist', 'build', 'target'],
            packageJson: { 'node_modules/pkg/package.json': '{"scripts":{"build":"x"}}' },
            truncated: false
        });

        assert.match(rendered, /Languages: TypeScript \(1\)/);
        assert.doesNotMatch(rendered, /node_modules|dist\/|build\/|target\//);
    });

    test('reports invalid package JSON and a capped discovery', () => {
        const rendered = renderWorkspaceOverview({
            files: ['package.json'],
            directories: [],
            packageJson: { 'package.json': '{invalid' },
            truncated: true
        });
        assert.match(rendered, /package\.json: unreadable JSON/);
        assert.match(rendered, /Discovery stopped after 1500 entries/);
    });
});

suite('projectContext: applyBudget', () => {
    test('returns text unchanged when within budget', () => {
        assert.strictEqual(applyBudget('hello', 100), 'hello');
    });

    test('truncates and appends a note when over budget', () => {
        const result = applyBudget('x'.repeat(500), 60);
        assert.ok(result.length <= 60);
        assert.ok(result.endsWith('[context truncated to fit budget]'));
    });

    test('treats a non-positive budget as unlimited', () => {
        assert.strictEqual(applyBudget('anything', 0), 'anything');
    });
});
