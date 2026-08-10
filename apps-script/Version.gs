/**
 * Version.gs — one string, and the reason it exists.
 *
 * There is no clasp, so what is LIVE is whatever was last pasted into the editor, and what is in git
 * is whatever was last pushed. Those two can drift apart in both directions: paste without pushing
 * and git is behind reality; push without pasting and git is ahead of it.
 *
 * This is the marker that lets anyone tell. Bump it in the same commit as any change to a SHARED
 * file, paste it along with that change, and put the number in the Slack post. Then "which version
 * is live?" is answerable from the sheet in two clicks, and "does it match git?" is a glance.
 *
 * Scenario files do not need a bump — they only affect their own owner's data.
 */

const TOOLKIT_VERSION = '1.3.0';
const TOOLKIT_VERSION_DATE = '2026-08-10';
const TOOLKIT_VERSION_NOTE = 'Module id preflight, Repair Courses, courses fail loudly on empty drafts.';

/** Developer -> About. Answers "is what I am running the same as what is in git?" */
function showVersion() {
  uiAlert('MCP Demo Seeder — version',
    'Installed in this script project:\n\n' +
    '   v' + TOOLKIT_VERSION + '   (' + TOOLKIT_VERSION_DATE + ')\n' +
    '   ' + TOOLKIT_VERSION_NOTE + '\n\n' +
    'Compare with the repository:\n\n' +
    '   git log --oneline -1\n' +
    '   grep TOOLKIT_VERSION apps-script/Version.gs\n\n' +
    'If they differ, someone pasted a shared file without pushing, or pushed without pasting. ' +
    'Ask in Slack before changing anything else — you may be looking at code nobody else is running.');
}
