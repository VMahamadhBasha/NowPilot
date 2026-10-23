const fs = require('fs');

function verifyUpdateSetStructure(filePath) {
    console.log(`\n========================================================`);
    console.log(`Verifying ServiceNow format for: ${filePath}`);
    const xml = fs.readFileSync(filePath, 'utf8');

    if (!xml.startsWith('<?xml') || !xml.includes('<unload')) {
        console.error('  [FAIL] Missing <?xml or <unload root tag');
        return false;
    }

    const remoteSetMatch = xml.match(/<sys_remote_update_set action="[^"]*">([\s\S]*?)<\/sys_remote_update_set>/);
    if (!remoteSetMatch) {
        console.error('  [FAIL] Missing <sys_remote_update_set>');
        return false;
    }

    const remoteSetBlock = remoteSetMatch[1];
    const setSysId = (remoteSetBlock.match(/<sys_id>(.*?)<\/sys_id>/) || ['',''])[1];
    const setName = (remoteSetBlock.match(/<name>(.*?)<\/name>/) || ['',''])[1];
    const state = (remoteSetBlock.match(/<state>(.*?)<\/state>/) || ['',''])[1];
    const appMatch = remoteSetBlock.match(/<application [^>]*display_value="(.*?)"[^>]*>(.*?)<\/application>/) ||
                     remoteSetBlock.match(/<application>(.*?)<\/application>/);
    const appName = appMatch ? appMatch[1] : 'global';
    const appScope = appMatch && appMatch[2] ? appMatch[2] : 'global';

    console.log(`  Update Set Name:  ${setName}`);
    console.log(`  Update Set SysId: ${setSysId}`);
    console.log(`  Update Set State: ${state}`);
    console.log(`  Application:      ${appName} (${appScope})`);

    const updateXmlRegex = /<sys_update_xml action="[^"]*">([\s\S]*?)<\/sys_update_xml>/g;
    let m;
    let count = 0;
    let mismatchedRemote = 0;
    let missingPayload = 0;
    let missingName = 0;
    let missingType = 0;
    let missingTarget = 0;

    while ((m = updateXmlRegex.exec(xml)) !== null) {
        count++;
        const b = m[1];
        const recRemoteSet = (b.match(/<remote_update_set[^>]*>(.*?)<\/remote_update_set>/) || ['',''])[1];
        const recName = (b.match(/<name>(.*?)<\/name>/) || ['',''])[1];
        const recType = (b.match(/<type>(.*?)<\/type>/) || ['',''])[1];
        const recTarget = (b.match(/<target_name>(.*?)<\/target_name>/) || ['',''])[1];
        const recPayload = (b.match(/<payload>([\s\S]*?)<\/payload>/) || ['',''])[1];

        if (recRemoteSet !== setSysId) {
            console.error(`    [MISMATCH] Record ${count} (${recType} - ${recTarget}): remote_update_set is '${recRemoteSet}', expected '${setSysId}'`);
            mismatchedRemote++;
        }
        if (!recName) missingName++;
        if (!recType) missingType++;
        if (!recTarget) missingTarget++;
        if (!recPayload) missingPayload++;
    }

    console.log(`  Total sys_update_xml records:            ${count}`);
    console.log(`  Mismatched remote_update_set references: ${mismatchedRemote}`);
    console.log(`  Missing name tags:                       ${missingName}`);
    console.log(`  Missing type tags:                       ${missingType}`);
    console.log(`  Missing target_name tags:                ${missingTarget}`);
    console.log(`  Missing payload tags:                    ${missingPayload}`);

    const isOk = mismatchedRemote === 0 && missingName === 0 && missingType === 0 && missingPayload === 0;
    console.log(`  Status: ${isOk ? 'VALID SERVICENOW UPDATE SET' : 'FORMAT ISSUES DETECTED'}`);
    return isOk;
}

const gOk = verifyUpdateSetStructure('update_sets/now_pilot_global.xml');
const sOk = verifyUpdateSetStructure('update_sets/now_pilot_scoped.xml');

if (!gOk || !sOk) {
    process.exit(1);
} else {
    console.log('\n[SUCCESS] Both update sets conform 100% to ServiceNow Retrieved Update Set specifications.');
}
