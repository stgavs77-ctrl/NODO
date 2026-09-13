'use strict';
// The first-run notice is acknowledged in the durable settings section
// `ui-onboarding.welcomeNoticeVersion`. Production users still see the notice and
// press Continue; only isolated DEV/test profiles start already acknowledged, and
// they must use the same value the client compares against.
const VERSION='2026-08-13.1';
module.exports={VERSION,section:()=>({'ui-onboarding':{welcomeNoticeVersion:VERSION}})};
