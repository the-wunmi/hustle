// Every module that registers a DBOS workflow, so all are registered before DBOS launches and can
// be recovered. A new workflow module must be added here.
import './agents/manage.ts';
import './calls.ts';
import './players.ts';
import './seed.ts';
import './trade.ts';
import './world/day.ts';
import './world/jobs.ts';
