"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const manifest = require("./package.json");
const output = path.join(__dirname, "dist", `${manifest.name}-${manifest.version}.vsix`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "remote-proxy-vsix-"));
try {
  fs.mkdirSync(path.join(staging, "extension"));
  for (const file of ["package.json", "extension.js", "broker.js", "askpass.js", "ssh-config.js", "README.md", "LICENSE"]) {
    fs.copyFileSync(path.join(__dirname, file), path.join(staging, "extension", file));
  }
  fs.mkdirSync(path.join(staging, "extension", "assets"));
  fs.copyFileSync(path.join(__dirname, manifest.icon), path.join(staging, "extension", manifest.icon));
  fs.writeFileSync(path.join(staging, "[Content_Types].xml"), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Override PartName="/extension/LICENSE" ContentType="text/plain"/>
</Types>
`);
  fs.writeFileSync(path.join(staging, "extension.vsixmanifest"), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"/>
    <DisplayName>${manifest.displayName}</DisplayName>
    <Description xml:space="preserve">${manifest.description}</Description>
    <Tags>proxy,ssh,devcontainer</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/>
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/${manifest.icon}</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${manifest.icon}" Addressable="true"/>
  </Assets>
</PackageManifest>
`);
  if (fs.existsSync(output)) fs.unlinkSync(output);
  const result = spawnSync("zip", ["-q", "-r", output, "[Content_Types].xml", "extension.vsixmanifest", "extension"], {
    cwd: staging, encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `zip exited ${result.status}`);
  console.log(output);
} finally {
  fs.rmSync(staging, { recursive: true });
}
