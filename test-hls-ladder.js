#!/usr/bin/env node

/**
 * Script to test HLS ladder generation locally
 * Usage: node test-hls-ladder.js <input-video-file>
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.argv.length < 3) {
  console.error('Usage: node test-hls-ladder.js <input-video-file>');
  process.exit(1);
}

const inputFile = process.argv[2];
if (!fs.existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  process.exit(1);
}

const outputDir = './test-output-hls';

// Clean and create output directory
if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true });
}
fs.mkdirSync(outputDir, { recursive: true });

console.log(`🎬 Testing HLS ladder generation...`);
console.log(`📁 Input: ${inputFile}`);
console.log(`📁 Output: ${outputDir}`);

// Test ladder configuration (same as worker)
const ladder = [
  { width: 1920, height: 1080, videoBitrateKbps: 6000, audioBitrateKbps: 128 }, // 1080p
  { width: 1280, height: 720, videoBitrateKbps: 3000, audioBitrateKbps: 128 },  // 720p
  { width: 854, height: 480, videoBitrateKbps: 1500, audioBitrateKbps: 128 },   // 480p
  { width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 128 },    // 360p
  { width: 426, height: 240, videoBitrateKbps: 400, audioBitrateKbps: 128 },    // 240p
];

console.log(`\n🔄 Generating ${ladder.length} quality variants...\n`);

// Generate each variant
const variants = [];
for (let i = 0; i < ladder.length; i++) {
  const variant = ladder[i];
  const playlistName = `variant_${variant.height}p.m3u8`;
  const segmentPrefix = `segment_${variant.height}p_%03d.ts`;
  
  console.log(`⚙️  Encoding ${variant.width}x${variant.height} @ ${variant.videoBitrateKbps}kbps...`);
  
  try {
    const cmd = [
      'ffmpeg', '-y',
      '-i', `"${inputFile}"`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', 'veryfast',
      `-vf`, `scale=${variant.width}:${variant.height}`,
      `-b:v`, `${variant.videoBitrateKbps}k`,
      `-b:a`, `${variant.audioBitrateKbps}k`,
      '-sc_threshold', '0',
      '-g', '48',
      '-keyint_min', '48',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      `-hls_segment_filename`, path.join(outputDir, segmentPrefix),
      path.join(outputDir, playlistName)
    ].join(' ');
    
    execSync(cmd, { stdio: 'pipe' });
    
    const bandwidth = Math.round((variant.videoBitrateKbps + variant.audioBitrateKbps) * 1100);
    variants.push({
      width: variant.width,
      height: variant.height,
      bandwidth,
      playlistPath: playlistName
    });
    
    console.log(`✅ ${variant.height}p variant completed`);
  } catch (error) {
    console.error(`❌ Failed to encode ${variant.height}p:`, error.message);
  }
}

// Generate master playlist
console.log(`\n📝 Generating master playlist...`);
let masterContent = '#EXTM3U\n#EXT-X-VERSION:6\n\n';

// Sort by quality (highest first)
const sortedVariants = variants.sort((a, b) => b.bandwidth - a.bandwidth);

for (const variant of sortedVariants) {
  masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}\n`;
  masterContent += `${variant.playlistPath}\n\n`;
}

const masterPath = path.join(outputDir, 'master.m3u8');
fs.writeFileSync(masterPath, masterContent);

console.log(`✅ Master playlist generated: ${masterPath}`);

// Display results
console.log(`\n🎉 HLS ladder generation completed!`);
console.log(`📊 Generated variants:`);
sortedVariants.forEach(v => {
  console.log(`   • ${v.width}x${v.height} @ ${Math.round(v.bandwidth/1000)}kbps`);
});

console.log(`\n📁 Output files:`);
fs.readdirSync(outputDir).forEach(file => {
  const stats = fs.statSync(path.join(outputDir, file));
  console.log(`   • ${file} (${Math.round(stats.size/1024)}KB)`);
});

console.log(`\n🔍 To validate HLS output:`);
console.log(`   1. Install Apple HLS Tools: https://developer.apple.com/downloads/`);
console.log(`   2. Run: mediastreamvalidator ${masterPath}`);
console.log(`   3. Or test in browser with hls.js player`);
