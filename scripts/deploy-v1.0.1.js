#!/usr/bin/env node

/**
 * ASVA V1.0.1 生产部署脚本
 * 
 * 本脚本封装 V1.0.1 部署的关键步骤，确保使用正确的 CLI 版本和参数。
 * 
 * 用法:
 *   node scripts/deploy-v1.0.1.js <command>
 * 
 * 命令:
 *   migrate          执行数据库迁移
 *   setup-key        配置加密密钥
 *   test-encryption  测试加密解密闭环
 *   deploy           部署后端代码
 *   publish          发布新版本
 *   switch-route     切换 HTTP 网关路由
 *   verify           验证部署结果
 *   rollback         回滚到 v41
 * 
 * 环境变量:
 *   TCB_NEW_PATH     新版 CLI 路径（默认: /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb）
 *   ENV_ID           CloudBase 环境 ID（默认: root-journey-prod-d4d7pzd0a8f805）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TCB_PATH = process.env.TCB_NEW_PATH || '/tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb';
const ENV_ID = process.env.ENV_ID || 'root-journey-prod-d4d7pzd0a8f805';
const MIGRATION_FILE = 'cloudbase/migrations/20261125200000_asva_assessment_ux_optimization.sql';

function runTcb(args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [TCB_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}\n${stderr}\n${stdout}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function migrate() {
  console.log('📦 执行数据库迁移...');
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  
  try {
    const result = await runTcb([
      'db', 'execute',
      '-e', ENV_ID,
      '--sql', sql,
      '--json'
    ]);
    console.log('✅ 数据库迁移成功');
    console.log(result);
  } catch (error) {
    console.error('❌ 数据库迁移失败:', error.message);
    process.exit(1);
  }
}

async function setupKey() {
  console.log('🔐 配置加密密钥...');
  
  // 创建配置表
  try {
    await runTcb([
      'db', 'execute',
      '-e', ENV_ID,
      '--sql', `
        CREATE TABLE IF NOT EXISTS public.asva_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
      `,
      '--json'
    ]);
    console.log('✅ 配置表已创建');
  } catch (error) {
    console.error('❌ 创建配置表失败:', error.message);
    process.exit(1);
  }

  // 生成加密密钥
  const encryptionKey = execSync('openssl rand -hex 32', { encoding: 'utf8' }).trim();
  console.log(`🔑 生成加密密钥: ${encryptionKey.substring(0, 16)}...`);

  // 存储密钥
  try {
    await runTcb([
      'db', 'execute',
      '-e', ENV_ID,
      '--sql', `
        INSERT INTO public.asva_config (key, value) 
        VALUES ('encryption_key', '${encryptionKey}')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;
      `,
      '--json'
    ]);
    console.log('✅ 加密密钥已存储');
    console.log(`\n⚠️  重要: 请安全保存此密钥: ${encryptionKey}`);
    console.log('⚠️  此密钥用于加密分享链接，丢失将无法恢复已加密的数据\n');
  } catch (error) {
    console.error('❌ 存储加密密钥失败:', error.message);
    process.exit(1);
  }
}

async function testEncryption() {
  console.log('🧪 测试加密解密闭环...');
  
  const testKey = 'aceca5f5030246cda809c80f3b25545e94bcfb9b24567f7bbfd910680355ed43';
  const testUrl = 'https://example.mindtest.com/report/abc123?token=xyz789';
  
  try {
    const result = await runTcb([
      'db', 'execute',
      '-e', ENV_ID,
      '--sql', `
        SET asva.encryption_key = '${testKey}';
        SELECT 
          pgp_sym_encrypt('${testUrl}', current_setting('asva.encryption_key')) as encrypted,
          pgp_sym_decrypt(
            pgp_sym_encrypt('${testUrl}', current_setting('asva.encryption_key')),
            current_setting('asva.encryption_key')
          ) as decrypted;
      `,
      '--json'
    ]);
    
    const parsed = JSON.parse(result);
    const decrypted = JSON.parse(parsed.data.Rows[0])[1];
    
    if (decrypted === testUrl) {
      console.log('✅ 加密解密测试通过');
      console.log(`   原始 URL: ${testUrl}`);
      console.log(`   解密 URL: ${decrypted}`);
    } else {
      console.error('❌ 解密结果不匹配');
      console.error(`   期望: ${testUrl}`);
      console.error(`   实际: ${decrypted}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ 加密解密测试失败:', error.message);
    process.exit(1);
  }
}

async function deploy() {
  console.log('🚀 部署后端代码...');
  
  try {
    const result = await runTcb([
      'fn', 'code', 'update',
      'asva-api',
      '-e', ENV_ID,
      '--dir', 'cloudbase/functions/asva-api',
      '--json'
    ]);
    console.log('✅ 代码部署成功');
    console.log(result);
  } catch (error) {
    console.error('❌ 代码部署失败:', error.message);
    process.exit(1);
  }
}

async function publish() {
  console.log('📤 发布新版本...');
  
  try {
    const result = await runTcb([
      'fn', 'publish-version',
      'asva-api',
      '-e', ENV_ID,
      '--description', 'V1.0.1 UX Optimization',
      '--json'
    ]);
    console.log('✅ 版本发布成功');
    console.log(result);
    console.log('\n⚠️  请记录版本号，用于后续路由切换');
  } catch (error) {
    console.error('❌ 版本发布失败:', error.message);
    process.exit(1);
  }
}

async function switchRoute(version) {
  if (!version) {
    console.error('❌ 请提供版本号: node scripts/deploy-v1.0.1.js switch-route <version>');
    process.exit(1);
  }
  
  console.log(`🔀 切换 HTTP 网关到版本 ${version}...`);
  
  try {
    // 查看当前路由
    const currentRoute = await runTcb([
      'routes', 'list',
      '-e', ENV_ID,
      '--json'
    ]);
    console.log('当前路由配置:');
    console.log(currentRoute);
    
    // 切换路由
    const result = await runTcb([
      'routes', 'edit',
      '-e', ENV_ID,
      '--data', JSON.stringify({
        domain: '*',
        routes: [{
          path: '/asva-api',
          upstreamResourceVersion: version
        }]
      }),
      '--json'
    ], { input: 'Y\n' });
    
    console.log('✅ 路由切换成功');
    console.log(result);
  } catch (error) {
    console.error('❌ 路由切换失败:', error.message);
    process.exit(1);
  }
}

async function verify() {
  console.log('🔍 验证部署结果...');
  
  // 检查 Health 端点
  try {
    const health = execSync(
      'curl -s https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api/api/health',
      { encoding: 'utf8' }
    );
    const healthJson = JSON.parse(health);
    
    console.log('✅ Health 端点响应正常');
    console.log(`   Commit: ${healthJson.gitCommit}`);
    console.log(`   Release: ${healthJson.release}`);
    
    if (healthJson.gitCommit === '8aa2ec13c5997f081077eb97f83d1dc9d5629c57') {
      console.log('✅ Commit hash 正确');
    } else {
      console.warn('⚠️  Commit hash 不匹配，可能路由未切换');
    }
  } catch (error) {
    console.error('❌ Health 端点检查失败:', error.message);
  }
  
  // 检查新接口
  try {
    const testResult = execSync(
      'curl -s https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api/api/assessments/bindings/test-id/update-history',
      { encoding: 'utf8' }
    );
    const testJson = JSON.parse(testResult);
    
    if (testJson.code === 'AUTH_REQUIRED') {
      console.log('✅ V1.0.1 新接口已生效（返回 AUTH_REQUIRED）');
    } else if (testJson.code === 'NOT_FOUND') {
      console.error('❌ V1.0.1 新接口未生效（返回 NOT_FOUND）');
      console.error('   请检查 HTTP 网关路由是否已切换');
    } else {
      console.warn('⚠️  新接口返回意外结果:', testJson);
    }
  } catch (error) {
    console.error('❌ 新接口检查失败:', error.message);
  }
}

async function rollback() {
  console.log('⏪ 回滚到 v41...');
  
  try {
    const result = await runTcb([
      'routes', 'edit',
      '-e', ENV_ID,
      '--data', JSON.stringify({
        domain: '*',
        routes: [{
          path: '/asva-api',
          upstreamResourceVersion: '41'
        }]
      }),
      '--json'
    ], { input: 'Y\n' });
    
    console.log('✅ 已回滚到 v41');
    console.log(result);
  } catch (error) {
    console.error('❌ 回滚失败:', error.message);
    process.exit(1);
  }
}

// 主程序
async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];
  
  // 检查 CLI 版本
  try {
    const version = execSync(`node ${TCB_PATH} --version`, { encoding: 'utf8' });
    console.log(`使用 CloudBase CLI: ${version.trim()}\n`);
  } catch (error) {
    console.error('❌ 无法访问 CloudBase CLI');
    console.error(`   请确保已安装: ${TCB_PATH}`);
    console.error('   或设置环境变量 TCB_NEW_PATH');
    process.exit(1);
  }
  
  switch (command) {
    case 'migrate':
      await migrate();
      break;
    case 'setup-key':
      await setupKey();
      break;
    case 'test-encryption':
      await testEncryption();
      break;
    case 'deploy':
      await deploy();
      break;
    case 'publish':
      await publish();
      break;
    case 'switch-route':
      await switchRoute(arg);
      break;
    case 'verify':
      await verify();
      break;
    case 'rollback':
      await rollback();
      break;
    default:
      console.log(`
ASVA V1.0.1 生产部署脚本

用法: node scripts/deploy-v1.0.1.js <command> [options]

命令:
  migrate              执行数据库迁移
  setup-key            配置加密密钥
  test-encryption      测试加密解密闭环
  deploy               部署后端代码
  publish              发布新版本
  switch-route <ver>   切换 HTTP 网关路由到指定版本
  verify               验证部署结果
  rollback             回滚到 v41

完整部署流程:
  1. node scripts/deploy-v1.0.1.js migrate
  2. node scripts/deploy-v1.0.1.js setup-key
  3. node scripts/deploy-v1.0.1.js test-encryption
  4. npm run build:cloudbase
  5. node scripts/deploy-v1.0.1.js deploy
  6. node scripts/deploy-v1.0.1.js publish
  7. node scripts/deploy-v1.0.1.js switch-route <版本号>
  8. node scripts/deploy-v1.0.1.js verify

环境变量:
  TCB_NEW_PATH    新版 CLI 路径（默认: /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb）
  ENV_ID          CloudBase 环境 ID（默认: root-journey-prod-d4d7pzd0a8f805）
      `);
  }
}

main().catch(error => {
  console.error('❌ 部署失败:', error.message);
  process.exit(1);
});
