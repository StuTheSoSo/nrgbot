import * as assert from 'assert';
import {
    parseSolutionProjects,
    languageFromExt,
    extractProjectFacts,
    applyBudget
} from '../projectContext';

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
