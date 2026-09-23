/**
 * Test harness for bashHasWriteIntent() in index.ts.
 * Loads the REAL TypeScript implementation through pi's bundled jiti, so the
 * tests always exercise the shipped code (no copy-paste drift).
 * Usage: node check.cjs   (exit 0 = all pass)
 */
const path = require("node:path");
const { readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");

const PI_DIR = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = require(path.join(PI_DIR, "node_modules/jiti/lib/jiti.cjs"));

// bashHasWriteIntent is module-private; extract its source block (plus the
// stripQuotes helper) into a temp shim module and load it through jiti.
const src = readFileSync(path.join(__dirname, "index.ts"), "utf8");
const start = src.indexOf("const stripQuotes");
const end = src.indexOf("\n/**\n * Choose a terminal editor");
if (start < 0 || end < 0) throw new Error("detector source block not found in index.ts");
const shimFile = path.join(mkdtempSync(path.join(tmpdir(), "plan-switch-check-")), "detector.ts");
writeFileSync(shimFile, src.slice(start, end) + "\nexport { bashHasWriteIntent };\n");

const { bashHasWriteIntent } = createJiti(__filename, { interopDefault: true })(shimFile);

// ---------------------------------------------------------------- test cases

const readOnly = [
	// basics
	"ls",
	"ls -la",
	"pwd",
	"cat README.md",
	"cat docs/overleaf/moveDroid_nier.tex",
	"grep -rn 'foo' src/",
	"rg 'pattern' .",
	"find . -name '*.py'",
	"which node",
	"echo hello", // echo to stdout only
	"printf 'probe'", // printf to stdout
	"head -50 file.txt",
	"tail -20 log.txt",
	"wc -l src/*.py",
	"file binary",
	"stat somefile",
	"du -sh .",
	"df -h",
	"env",
	"printenv PATH",
	// stderr suppression — the originally reported false-positive family
	"cat ~/.pi/agent/models.json 2>/dev/null || echo 'NOT EXIST'",
	"ls -la ~/.pi/agent/models.json 2>/dev/null",
	"grep -a 'zai-api' /tmp/lm.log 2>/dev/null | head",
	"grep -rln 'glm-5.3-flash' dist/ 2>/dev/null | grep -v '.map'",
	"cat foo 2>/dev/null",
	"somecmd arg 2>/dev/null",
	"python3 --version 2>&1",
	"git status 2>&1",
	"git log --oneline -5 2>/dev/null",
	"git diff --stat",
	"git show HEAD --stat",
	"pip list 2>/dev/null | grep appium",
	// pipes / quoting
	"ps aux | grep appium",
	"ps aux | grep -i 'node' | grep -v grep",
	"cat file | head -3 | wc -l",
	"adb devices",
	"uname -a",
	"date",
	"python3 -c 'print(1)'",
	"node -e 'console.log(1)'",
	"grep -rn 'import' . --include='*.ts'",
	"sed -n '1,10p' file.txt", // sed WITHOUT -i is read-only
	"awk '/foo/ {print}' file.txt",
	"diff a.txt b.txt",
	"python3 -m json.tool config.json",
	// quoted strings are data, not shell syntax
	"echo 'a > b' | wc -c",
	'grep "pattern with > char" file.txt',
	"grep -rn 'writeFileSync' src/",
	"grep -rn '.write(' src/",
	"grep -rn 'os.remove' .",
	"grep -rn 'shutil.rmtree' .",
	"rg 'open\\(' .",
	"grep -rn writeFileSync src/", // unquoted search pattern too
	"grep make README.md",
	// /dev/null family
	"echo test > /dev/null",
	"echo hi 2>/dev/null",
	"cmd >/dev/null 2>&1",
	"cmd 2>&1 >/dev/null",
	"cat foo 2>/dev/null | head",
	"find . -maxdepth 2 -name '*.json' 2>/dev/null",
	// network / archive reads
	"curl -s https://example.com | head",
	"curl -I https://example.com",
	"tar -tf archive.tar.gz",
	"command -v ffmpeg",
	"date +%s",
	"echo $((1+1))",
	"pip show requests",
];

const writes = [
	// redirection
	"echo hi > out.txt",
	"echo hi >> out.txt",
	"cat a > b",
	"cmd > /tmp/x.log 2>&1",
	"cmd 2>&1 > /tmp/x.log",
	"echo data >> ~/.zshrc",
	// heredoc
	"cat > file <<EOF\nhi\nEOF",
	"cat <<'JSON' > models.json\n{}\nJSON",
	// destructive words
	"rm -rf build",
	"rm file",
	"mv a b",
	"cp a b",
	"touch newfile",
	"mkdir dir",
	"truncate -s 0 f",
	"tee out.txt",
	"chmod +x run.sh",
	"ln -s a b",
	"git add .",
	"git commit -m x",
	"git push",
	"git reset --hard",
	"git clean -fd",
	"git checkout -b feat",
	"git stash",
	// package managers / builds
	"npm install",
	"npm i left-pad",
	"npm run build",
	"pip install requests",
	"pip3 install -r requirements.txt",
	"poetry add foo",
	"yarn add foo",
	"pnpm add foo",
	"cargo build",
	"cargo install x",
	"go build ./...",
	"go mod tidy",
	"make",
	"npx create-vite@latest",
	// in-place editors
	"sed -i 's/a/b/' file",
	"perl -i -pe 's/a/b/' file",
	"patch -p1 < fix.diff",
	// interpreters running script files (blocked BY DESIGN — may write)
	"python main.py",
	"python3 batch_run.py",
	"node script.js",
	"bash setup.sh",
	"sh x.sh",
	"node check.cjs 2>&1 | head",
	// inline write calls
	"python3 -c \"open('x','w').write('y')\"",
	"python3 -c \"open('x','w')\"",
	"node -e \"require('fs').writeFileSync('x','y')\"",
	"python3 -c \"import shutil; shutil.rmtree('d')\"",
	"python3 -c \"Path('x').mkdir()\"",
	"python3 -c \"from pathlib import Path; Path('x').write_text('y')\"",
	"echo hi | tee file.txt",
	// downloads / archives
	"curl -o out.html https://example.com",
	"curl --output out.html https://example.com",
	"curl -LO https://example.com/f.tar.gz",
	"wget https://example.com/file",
	"wget -O out.html https://example.com",
	"tar -xf archive.tar.gz",
	"tar -xzf archive.tgz",
	"tar --extract -f archive.tar",
	"find . -name '*.tmp' -delete",
	// misc mutation
	"docker rm x",
	"kubectl delete pod x",
	"sudo rm x",
];

// -------------------------------------------------------------------- runner

let pass = 0;
const failures = [];

for (const c of readOnly) {
	const hit = bashHasWriteIntent(c);
	if (hit === null) pass++;
	else failures.push(`FALSE-POSITIVE [read-only] ${JSON.stringify(c)} -> ${hit}`);
}
for (const c of writes) {
	const hit = bashHasWriteIntent(c);
	if (hit !== null) pass++;
	else failures.push(`MISSED-WRITE [write] ${JSON.stringify(c)}`);
}

for (const f of failures) console.log("FAIL:", f);
console.log(`\n${pass} passed, ${failures.length} failed (${readOnly.length} read-only, ${writes.length} write)`);
process.exit(failures.length === 0 ? 0 : 1);
