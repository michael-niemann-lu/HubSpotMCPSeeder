/**
 * Menu.gs — the only entry points a user should ever touch.
 *
 * Every scenario gets its own submenu, and every action in it carries that scenario in its label.
 * Choosing "Scenario 2 ▸ Reset" acts on uc2 whatever the Settings tab says, because the wrapper
 * sets a scope override for the duration of the call. Acting on the wrong scenario is the mistake
 * three people sharing one workbook will actually make, so the menu removes the chance rather than
 * relying on anyone remembering.
 *
 * Apps Script menus cannot pass arguments, hence the block of one-line wrappers at the bottom.
 *
 * Three verbs, and the menu order is the order you reach for them:
 *   Refresh   add what is missing, update what has drifted. The everyday action.
 *   Rebuild   delete and recreate enrollments so COMPLETION dates move. Destructive.
 *   Reset     delete this scenario's enrollments. Destructive.
 *
 * "Seed step by step" is the same work as Refresh, split into bounded phases. Useful for a first
 * seed when you want to watch each stage land, and unnecessary otherwise.
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu('MCP Demo Seeder');

  menu.addSubMenu(ui.createMenu('Setup')
    .addItem('Create / Repair Workbook', 'setupWorkbook')
    .addSeparator()
    .addItem('Set Credentials', 'setCredentials')
    .addItem('Check Credentials', 'checkCredentials')
    .addItem('Check Custom Fields', 'checkCustomFields')
    .addItem('Check Course Source', 'checkCourseSource')
    .addItem('Find a Module', 'findModule')
    .addSeparator()
    .addItem('Check HubSpot Connection', 'checkHubSpotCredentials')
    .addItem('Show HubSpot Pipelines', 'checkHubSpotPipelines')
    .addItem('Create / Update HubSpot Properties', 'setupHubSpotProperties')
    .addItem('Create / Update HubSpot Pipelines', 'setupHubSpotPipelines'));

  menu.addSeparator();
  menu.addSubMenu(scenarioMenu_(ui, 'uc1', '1'));
  menu.addSubMenu(scenarioMenu_(ui, 'uc2', '2'));
  menu.addSubMenu(scenarioMenu_(ui, 'uc3', '3'));

  menu.addSeparator();
  menu.addSubMenu(ui.createMenu('Developer')
    .addItem('About / Version', 'showVersion')
    .addItem('Run Unit Tests', 'runAllTests')
    .addItem('Show Column Contract', 'showColumnContract')
    .addItem('Show Resolved Dates', 'showResolvedDates')
    .addItem('Which portal am I pointed at?', 'showEnvironment')
    .addSeparator()
    .addItem('API Probe (GET only)', 'apiProbe')
    .addItem('Repair Manifest', 'repairManifest')
    .addItem('Remove Stray Enrollments', 'removeStrayEnrollments'));

  menu.addToUi();
}

/** One submenu per scenario, titled with its name and owner so you can see whose data it is. */
function scenarioMenu_(ui, useCase, n) {
  let title = 'Scenario ' + n;
  try {
    const s = scenarioFor(useCase);
    if (s && s.scenario_name) {
      title += ' — ' + s.scenario_name + (s.owner_name ? ' (' + s.owner_name + ')' : '');
    }
  } catch (e) { /* workbook not built yet */ }

  return ui.createMenu(title)
    .addItem('Load Sheet Data from Scenario' + n + '.gs', 'uc' + n + '_load')
    .addSeparator()
    .addItem('Validate', 'uc' + n + '_validate')
    .addItem('Preview (dry run)', 'uc' + n + '_preview')
    .addSeparator()
    .addItem('Refresh — add & update', 'uc' + n + '_refresh')
    .addItem('Refresh HubSpot dates', 'uc' + n + '_refreshHs')
    .addItem('Verify', 'uc' + n + '_verify')
    .addItem('Verify HubSpot', 'uc' + n + '_verifyHs')
    .addSeparator()
    .addSubMenu(ui.createMenu('Seed step by step')
      .addItem('LearnUpon 1. Users, Groups, Memberships', 'uc' + n + '_seedUsers')
      .addItem('LearnUpon 2. Courses', 'uc' + n + '_seedCourses')
      .addItem('LearnUpon 3. Enrollments', 'uc' + n + '_seedEnrollments')
      .addItem('LearnUpon 4. Completions', 'uc' + n + '_seedCompletions')
      .addSeparator()
      .addItem('HubSpot 5. Companies and Contacts', 'uc' + n + '_seedHsCompanies')
      .addItem('HubSpot 6. Tickets', 'uc' + n + '_seedHsTickets')
      .addItem('HubSpot 7. Deals', 'uc' + n + '_seedHsDeals')
      .addSeparator()
      .addItem('Shift Due Dates only', 'uc' + n + '_refreshDue'))
    .addSeparator()
    .addItem('Rebuild Enrollments (moves completion dates)', 'uc' + n + '_rebuild')
    .addItem('Reset — delete this scenario\'s enrollments', 'uc' + n + '_reset')
    .addItem('Reset HubSpot — archive this scenario\'s tickets and deals', 'uc' + n + '_resetHs');
}

function showEnvironment() {
  uiAlert('Current target portal',
    environmentLabel() + '\n\nChange it on the Settings tab (environment), then re-check credentials.');
}

// ---------------------------------------------------------------------------
// Per-scenario wrappers. Each sets the scope for the duration of one action.
// ---------------------------------------------------------------------------

function uc1_load() { runScenarioLoader_('uc1'); }
function uc1_validate() { withScope_('uc1', function () { validateWorkbook({}); }); }
function uc1_preview() { withScope_('uc1', previewSeedPlan); }
function uc1_refresh() { withScope_('uc1', refreshScenario); }
function uc1_seedUsers() { withScope_('uc1', seedUsersAndGroups); }
function uc1_seedCourses() { withScope_('uc1', seedCourses); }
function uc1_seedEnrollments() { withScope_('uc1', seedEnrollments); }
function uc1_seedCompletions() { withScope_('uc1', seedCompletions); }
function uc1_verify() { withScope_('uc1', verifySeed); }
function uc1_refreshDue() { withScope_('uc1', refreshDueDates); }
function uc1_rebuild() { withScope_('uc1', refreshRebuild); }
function uc1_seedHsCompanies() { withScope_('uc1', seedHubSpotCompanies); }
function uc1_seedHsTickets() { withScope_('uc1', seedHubSpotTickets); }
function uc1_seedHsDeals() { withScope_('uc1', seedHubSpotDeals); }
function uc1_reset() { withScope_('uc1', resetEnrollments); }
function uc1_refreshHs() { withScope_('uc1', refreshHubSpotDates); }
function uc1_verifyHs() { withScope_('uc1', verifyHubSpot); }
function uc1_resetHs() { withScope_('uc1', resetHubSpot); }

function uc2_load() { runScenarioLoader_('uc2'); }
function uc2_validate() { withScope_('uc2', function () { validateWorkbook({}); }); }
function uc2_preview() { withScope_('uc2', previewSeedPlan); }
function uc2_refresh() { withScope_('uc2', refreshScenario); }
function uc2_seedUsers() { withScope_('uc2', seedUsersAndGroups); }
function uc2_seedCourses() { withScope_('uc2', seedCourses); }
function uc2_seedEnrollments() { withScope_('uc2', seedEnrollments); }
function uc2_seedCompletions() { withScope_('uc2', seedCompletions); }
function uc2_verify() { withScope_('uc2', verifySeed); }
function uc2_refreshDue() { withScope_('uc2', refreshDueDates); }
function uc2_rebuild() { withScope_('uc2', refreshRebuild); }
function uc2_seedHsCompanies() { withScope_('uc2', seedHubSpotCompanies); }
function uc2_seedHsTickets() { withScope_('uc2', seedHubSpotTickets); }
function uc2_seedHsDeals() { withScope_('uc2', seedHubSpotDeals); }
function uc2_reset() { withScope_('uc2', resetEnrollments); }
function uc2_refreshHs() { withScope_('uc2', refreshHubSpotDates); }
function uc2_verifyHs() { withScope_('uc2', verifyHubSpot); }
function uc2_resetHs() { withScope_('uc2', resetHubSpot); }

function uc3_load() { runScenarioLoader_('uc3'); }
function uc3_validate() { withScope_('uc3', function () { validateWorkbook({}); }); }
function uc3_preview() { withScope_('uc3', previewSeedPlan); }
function uc3_refresh() { withScope_('uc3', refreshScenario); }
function uc3_seedUsers() { withScope_('uc3', seedUsersAndGroups); }
function uc3_seedCourses() { withScope_('uc3', seedCourses); }
function uc3_seedEnrollments() { withScope_('uc3', seedEnrollments); }
function uc3_seedCompletions() { withScope_('uc3', seedCompletions); }
function uc3_verify() { withScope_('uc3', verifySeed); }
function uc3_refreshDue() { withScope_('uc3', refreshDueDates); }
function uc3_rebuild() { withScope_('uc3', refreshRebuild); }
function uc3_seedHsCompanies() { withScope_('uc3', seedHubSpotCompanies); }
function uc3_seedHsTickets() { withScope_('uc3', seedHubSpotTickets); }
function uc3_seedHsDeals() { withScope_('uc3', seedHubSpotDeals); }
function uc3_reset() { withScope_('uc3', resetEnrollments); }
function uc3_refreshHs() { withScope_('uc3', refreshHubSpotDates); }
function uc3_verifyHs() { withScope_('uc3', verifyHubSpot); }
function uc3_resetHs() { withScope_('uc3', resetHubSpot); }
