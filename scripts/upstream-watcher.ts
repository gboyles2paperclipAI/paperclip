// upstream-watcher.ts
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface DependencyConfig {
  name: string;
  type: 'npm' | 'node' | 'pnpm' | 'custom';
  currentVersion: string; // This will be read from package.json dynamically, but useful for comparison
  upstreamSource?: string; // For custom types like embedded-postgres
}

interface ReportEntry {
  dependency: string;
  currentVersion: string;
  latestUpstreamVersion: string;
  status: 'up-to-date' | 'new-patch-available' | 'new-minor-available' | 'new-major-available' | 'patched-dependency-update' | 'error';
  releaseNotesUrl?: string;
  notes?: string;
}

const PACKAGE_JSON_PATH = path.join('/home/paperclipadmin/.paperclip/instances/default/workspaces/9c332d6d-e0d7-4478-9b73-ab102da0ea21/runtime-tools/paperclip-source', 'package.json');
const UPSTREAM_CONFIG_PATH = path.join('/home/paperclipadmin/.paperclip/instances/default/workspaces/9c332d6d-e0d7-4478-9b73-ab102da0ea21/runtime-tools/paperclip-source', 'upstream-config.json');

async function getLatestNpmVersion(packageName: string): Promise<string | null> {
  try {
    const result = execSync(`npm view ${packageName} version`, { encoding: 'utf8', stdio: 'pipe' });
    return result.trim();
  } catch (error) {
    console.error(`Error fetching latest NPM version for ${packageName}:`, error);
    return null;
  }
}

async function getLatestNodeLtsVersion(): Promise<string | null> {
  try {
    const response = await fetch('https://nodejs.org/dist/index.json');
    const data = await response.json();
    const ltsVersions = data.filter((item: any) => item.lts);
    // Find the latest LTS version
    const latestLts = ltsVersions.reduce((prev: any, current: any) => {
      const prevVersion = parseInt(prev.version.replace('v', '').split('.')[0]);
      const currentVersion = parseInt(current.version.replace('v', '').split('.')[0]);
      return currentVersion > prevVersion ? current : prev;
    });
    return latestLts ? latestLts.version.replace('v', '') : null;
  } catch (error) {
    console.error('Error fetching latest Node.js LTS version:', error);
    return null;
  }
}

async function getLatestPnpmVersion(): Promise<string | null> {
  return await getLatestNpmVersion('pnpm');
}

// Placeholder for embedded-postgres - would need a specific method based on its upstream source
async function getLatestEmbeddedPostgresVersion(upstreamSource: string): Promise<string | null> {
  // This would typically involve scraping a GitHub release page or an API.
  // For now, it's a placeholder.
  console.warn(`Manual check required for embedded-postgres from ${upstreamSource}`);
  return null;
}

function compareVersions(current: string, latest: string): 'up-to-date' | 'new-patch-available' | 'new-minor-available' | 'new-major-available' {
  const parse = (version: string) => version.split('.').map(Number);
  const [cMajor, cMinor, cPatch] = parse(current);
  const [lMajor, lMinor, lPatch] = parse(latest);

  if (lMajor > cMajor) return 'new-major-available';
  if (lMinor > cMinor) return 'new-minor-available';
  if (lPatch > cPatch) return 'new-patch-available';
  return 'up-to-date';
}

async function main() {
  let packageJson: any;
  try {
    packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  } catch (error) {
    console.error('Error reading package.json:', error);
    process.exit(1);
  }

  const devDependencies = packageJson.devDependencies || {};
  const patchedDependencies = packageJson.pnpm?.patchedDependencies || {};
  const overrides = packageJson.pnpm?.overrides || {};

  const dependenciesToMonitor: DependencyConfig[] = [];

  // Add devDependencies
  for (const depName in devDependencies) {
    dependenciesToMonitor.push({
      name: depName,
      type: 'npm',
      currentVersion: devDependencies[depName].replace(/[\^~]/, '') // Remove carets/tildes for exact comparison
    });
  }

  // Add Node.js engine
  if (packageJson.engines?.node) {
    dependenciesToMonitor.push({
      name: 'node',
      type: 'node',
      currentVersion: packageJson.engines.node.replace('>=', '')
    });
  }

  // Add pnpm package manager
  if (packageJson.packageManager) {
    dependenciesToMonitor.push({
      name: 'pnpm',
      type: 'pnpm',
      currentVersion: packageJson.packageManager.split('@')[1]
    });
  }

  // Add patched dependencies
  for (const depName in patchedDependencies) {
    dependenciesToMonitor.push({
      name: depName.split('@')[0], // Get package name without version
      type: 'custom', // Mark as custom for specific handling
      currentVersion: depName.split('@')[1], // Get the exact version
      upstreamSource: 'https://github.com/vaxilu/embedded-postgres' // Assuming this is the upstream
    });
  }

  // Add overrides
  for (const depName in overrides) {
    dependenciesToMonitor.push({
      name: depName,
      type: 'npm', // Treat overrides like npm dependencies for checking
      currentVersion: overrides[depName].replace(/[\^~>=]/g, '') // Remove carets/tildes/operators
    });
  }


  const report: ReportEntry[] = [];

  for (const dep of dependenciesToMonitor) {
    let latestUpstreamVersion: string | null = null;
    let releaseNotesUrl: string | undefined = undefined; // Placeholder for now

    if (dep.type === 'npm') {
      latestUpstreamVersion = await getLatestNpmVersion(dep.name);
    } else if (dep.type === 'node') {
      latestUpstreamVersion = await getLatestNodeLtsVersion();
      releaseNotesUrl = 'https://nodejs.org/en/blog/release';
    } else if (dep.type === 'pnpm') {
      latestUpstreamVersion = await getLatestPnpmVersion();
      releaseNotesUrl = 'https://github.com/pnpm/pnpm/releases';
    } else if (dep.type === 'custom' && dep.name === 'embedded-postgres') {
      // This is where we'd call a custom function for embedded-postgres
      // For now, we'll just report its current version and a note.
      latestUpstreamVersion = dep.currentVersion; // Default to current version if unable to fetch upstream
      report.push({
        dependency: dep.name,
        currentVersion: dep.currentVersion,
        latestUpstreamVersion: latestUpstreamVersion,
        status: 'patched-dependency-update',
        notes: `Patched dependency. Manual review of ${dep.upstreamSource} for updates is required.`
      });
      continue; // Skip further processing for this custom dependency for now
    }

    if (latestUpstreamVersion && latestUpstreamVersion !== dep.currentVersion) {
      const status = compareVersions(dep.currentVersion, latestUpstreamVersion);
      report.push({
        dependency: dep.name,
        currentVersion: dep.currentVersion,
        latestUpstreamVersion: latestUpstreamVersion,
        status: status,
        releaseNotesUrl: releaseNotesUrl
      });
    } else if (latestUpstreamVersion) {
      report.push({
        dependency: dep.name,
        currentVersion: dep.currentVersion,
        latestUpstreamVersion: latestUpstreamVersion,
        status: 'up-to-date',
        releaseNotesUrl: releaseNotesUrl
      });
    } else {
      report.push({
        dependency: dep.name,
        currentVersion: dep.currentVersion,
        latestUpstreamVersion: 'N/A',
        status: 'error',
        notes: 'Could not fetch latest upstream version.'
      });
    }
  }

  console.log(JSON.stringify(report, null, 2));

  // Optionally, write to a markdown file
  let markdownReport = '# Upstream Watch Report\n\n';
  report.forEach(entry => {
    markdownReport += `## ${entry.dependency}\n`;
    markdownReport += `- Current Version: \`${entry.currentVersion}\`\n`;
    markdownReport += `- Latest Upstream Version: \`${entry.latestUpstreamVersion}\`\n`;
    markdownReport += `- Status: **${entry.status.split('-').join(' ').toUpperCase()}**\n`;
    if (entry.releaseNotesUrl) {
      markdownReport += `- Release Notes: [Link](${entry.releaseNotesUrl})\n`;
    }
    if (entry.notes) {
      markdownReport += `- Notes: ${entry.notes}\n`;
    }
    markdownReport += '\n'; // Add a single newline after each entry
  });

  fs.writeFileSync(path.join('/home/paperclipadmin/.paperclip/instances/default/workspaces/9c332d6d-e0d7-4478-9b73-ab102da0ea21/runtime-tools/paperclip-source', 'UPSTREAM_REPORT.md'), markdownReport);
}

main();
