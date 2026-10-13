#include <stdlib.h>
#include <string.h>
int main(void){
 void *(*volatile allocate)(size_t)=malloc;void (*volatile release)(void*)=free;
 char *p=allocate(2*1024*1024);if(!p)return 2;memset(p,1,2*1024*1024);release(p);
 void *(*volatile zero)(size_t,size_t)=calloc;char *q=zero(2,1024*1024);if(!q)return 3;
 q=realloc(q,3*1024*1024);if(!q)return 4;q[0]=1;release(q);return 0;
}
