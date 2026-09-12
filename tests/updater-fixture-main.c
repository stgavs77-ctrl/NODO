#include <mach-o/dyld.h>
#include <limits.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <sys/wait.h>
int main(void){
 char executable[PATH_MAX],node[PATH_MAX],script[PATH_MAX];uint32_t size=sizeof(executable);
 if(_NSGetExecutablePath(executable,&size))return 90;
 char *slash=strrchr(executable,'/');if(!slash)return 91;*slash=0;
 snprintf(node,sizeof(node),"%s/../Resources/project/runtime/node",executable);
 snprintf(script,sizeof(script),"%s/../Resources/project/fixture-server.cjs",executable);
 pid_t child=fork();if(child<0)return 92;
 if(child==0){execl(node,node,script,(char*)NULL);_exit(93);}
 int status;while(waitpid(child,&status,0)<0){}return WIFEXITED(status)?WEXITSTATUS(status):94;
}
