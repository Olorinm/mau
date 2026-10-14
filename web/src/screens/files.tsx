import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ItemList, ListDetailLayout, PageHeader } from '@olorinm/agent-frontend';
import { Button, EmptyState } from '@olorinm/agent-ui/app';
import { request, ApiError, safeExternalUrl } from '../api/http';
import type { Session } from '../api/session';
import { useI18n, errorMessage } from '../i18n';

export function FilesScreen({session}:{session:Session}) {
 const {t,language}=useI18n();const zh=language==='zh-CN';const [selected,setSelected]=useState<string>();
 const spaces=useQuery({queryKey:['workspaces',session.owner],queryFn:()=>request<{data:Array<{id:string;name:string}>}>('/_mau/v1/workspaces',{token:session.token})});
 const files=useQuery({queryKey:['workspace-files',session.owner,selected],enabled:!!selected,
  queryFn:()=>request<{data:Array<{path:string;size:number}>}>(`/_mau/v1/workspaces/${encodeURIComponent(selected!)}/files`,{token:session.token})});
 const download=useMutation({mutationFn:async(path:string)=>{
  const result=await request<{url:string}>(`/_mau/v1/workspaces/${encodeURIComponent(selected!)}/download?path=${encodeURIComponent(path)}`,{token:session.token});
  const url=safeExternalUrl(result.url);if(!url)throw new ApiError('invalid_response',200);return {path,url};
 }});
 const error=spaces.error??files.error??download.error;
 return <ListDetailLayout detailOpen={!!selected} onBack={()=>{setSelected(undefined);download.reset();}} backLabel={zh?'工作区':'Workspaces'}
 list={<><PageHeader title={zh?'文件':'Files'}/>{spaces.isPending?<p>{t('common.loading')}</p>:null}
  {error?<p role="alert" className="mau-error">{errorMessage(t,error instanceof ApiError?error.code:'request_failed')}</p>:null}
  <ItemList label={zh?'工作区':'Workspaces'} {...(selected?{selectedId:selected}:{})} onSelect={id=>{setSelected(id);download.reset();}}
   items={(spaces.data?.data??[]).map(space=>({id:space.id,title:space.name}))}
   empty={spaces.isSuccess?<EmptyState illustration="sprout" title={zh?'暂无共享工作区':'No shared workspaces'}/>:null}/></>}
 detail={<div className="mau-agent-detail"><PageHeader title={spaces.data?.data.find(space=>space.id===selected)?.name}/>
  {files.isPending?<p>{t('common.loading')}</p>:null}
  <ItemList label={zh?'工作区文件':'Workspace files'} items={(files.data?.data??[]).map(file=>({id:file.path,title:file.path,description:`${file.size} B`}))} onSelect={path=>download.mutate(path)}
   empty={files.isSuccess?<p>{zh?'工作区中暂无文件。':'This workspace has no files.'}</p>:null}/>
  {download.data?<p><a href={download.data.url} target="_blank" rel="noopener noreferrer">{zh?'下载':'Download'} {download.data.path}</a></p>:null}
  <Button onClick={()=>void files.refetch()}>{t('common.retry')}</Button>
 </div>} empty={<EmptyState illustration="sprout" title={zh?'选择工作区':'Select a workspace'}/>}/>;
}
