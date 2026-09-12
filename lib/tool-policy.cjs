'use strict';
// Exact public names verified against the pinned DSH 0.1.5-rc.1 tool sources.
const NATIVE_TOOLS = Object.freeze(['web_search','web_fetch','skill','bash','read','write','edit','read_image','glob','grep','str_replace_editor','run_code','subagent','list_subagent_models','job_output','job_list','job_kill','get_goal','create_goal','update_goal','todo_write']);
const NODO_TOOLS = Object.freeze(['rc_browser','rc_read_file','rc_write_file','rc_list_files','rc_delegate_codex','rc_task_status']);
const EXTERNAL_TOOLS = Object.freeze(['telegram_read','telegram_reply','client_sessions_board']);
function createToolPolicy(env=process.env){
 const isolated=env.NODO_ISOLATED==='1';
 const names=new Set([...NATIVE_TOOLS,...NODO_TOOLS,...(isolated?[]:EXTERNAL_TOOLS)]);
 const reaper=!isolated && env.NODO_ENABLE_REAPER==='1';
 const permits=name=>names.has(name)||(reaper&&/^mcp__reaper__[a-zA-Z0-9_-]+$/.test(name));
 return {isolated,names,permits,guard:exec=>permits(exec.name)?undefined:'NODO: tool is not enabled by this profile. Isolated DEV blocks Telegram and external MCP.'};
}
module.exports={createToolPolicy,NATIVE_TOOLS,NODO_TOOLS,EXTERNAL_TOOLS};
