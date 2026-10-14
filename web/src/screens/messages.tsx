import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Conversation, ItemList, ListDetailLayout, PageHeader } from '@olorinm/agent-frontend';
import { Button, EmptyState, EmployeeAvatar } from '@olorinm/agent-ui/app';
import { ChatMarkdown } from '@olorinm/agent-ui';
import { mauApi } from '../api/client';
import { MauConversations } from '../api/conversations';
import { ApiError } from '../api/http';
import type { Session } from '../api/session';
import { useI18n, errorMessage } from '../i18n';

export function MessagesScreen({session}:{session:Session}) {
 const {t,language}=useI18n();const zh=language==='zh-CN';const queries=useQueryClient();
 const agents=useQuery({queryKey:['agents',session.owner],queryFn:()=>mauApi(session.token).agents()});
 const identity=JSON.stringify(agents.data?.map(({agent})=>[agent.id,agent.matrixId,agent.name]));
 const client=useMemo(()=>new MauConversations(session,agents.data??[]),[session.token,identity]);
 const key=['conversations',session.owner,identity];
 const rooms=useQuery({queryKey:key,queryFn:({signal})=>client.sync(signal),enabled:!!agents.data?.length,refetchInterval:1000});
 const [selected,setSelected]=useState<string>();const [target,setTarget]=useState('');
 const [drafts,setDrafts]=useState<Record<string,string>>({});
 const current=(rooms.data??client.snapshot()).find(room=>room.id===selected);
 const start=useMutation({mutationFn:()=>client.start(target),onSuccess:id=>{setSelected(id);queries.setQueryData(key,client.snapshot());}});
 // Keep transaction IDs on a failed delivery so Retry cannot duplicate an accepted Matrix event.
 const [outgoing,setOutgoing]=useState<{room:string;text:string;transaction:string}>();
 const send=useMutation({mutationFn:(message:{room:string;text:string;transaction:string})=>client.send(message.room,message.text,message.transaction),
  onSuccess:(_,message)=>{setDrafts(values=>({...values,[message.room]:values[message.room]===message.text?'':values[message.room]??''}));setOutgoing(undefined);queries.setQueryData(key,client.snapshot());}});
 const error=agents.error??rooms.error??start.error??send.error;
 const failure=error?<p role="alert" className="mau-error">{errorMessage(t,error instanceof ApiError?error.code:'request_failed')}</p>:null;
 const list=<><PageHeader title={zh?'消息':'Messages'}/>{failure}
  {agents.isPending||rooms.isFetching&&!rooms.data?<p className="mau-muted">{t('common.loading')}</p>:null}
  <label className="mau-field"><span>{zh?'开始对话':'Start a conversation'}</span><select value={target} onChange={e=>setTarget(e.target.value)}>
    <option value="">{zh?'选择员工':'Select an Agent'}</option>{agents.data?.map(({agent})=><option key={agent.id} value={agent.id}>{agent.name}</option>)}
  </select></label><Button disabled={!target||start.isPending} onClick={()=>start.mutate()}>{zh?'打开对话':'Open conversation'}</Button>
  <ItemList label={zh?'会话':'Conversations'} {...(selected?{selectedId:selected}:{})} onSelect={setSelected} items={(rooms.data??client.snapshot()).map(room=>({id:room.id,title:room.group?`${room.title} (${zh?'群聊':'Group'})`:room.title,description:room.messages.at(-1)?.text??'',leading:<EmployeeAvatar seed={room.agentId} fallbackName={room.title} size={32}/>}))}/>
 </>;
 return <ListDetailLayout list={list} detailOpen={!!current} onBack={()=>setSelected(undefined)} backLabel={zh?'消息':'Messages'} empty={<EmptyState illustration="messages" title={zh?'选择员工开始对话':'Select an Agent to begin'}/>}
 detail={current?<Conversation header={<PageHeader title={current.group?`${current.title} (${zh?'群聊':'Group'})`:current.title} description={current.group?`${current.participants} ${zh?'位成员':'participants'}`:undefined}/>} notice={<>{failure}{current.limited?<p className="mau-muted">{zh?'当前显示最近消息。':'Showing recent messages.'}</p>:null}{send.isError&&outgoing?.room===current.id?<><Button onClick={()=>send.mutate(outgoing)}>{t('common.retry')}</Button><Button onClick={()=>{setOutgoing(undefined);send.reset();}}>{zh?'放弃重试':'Dismiss retry'}</Button></>:null}</>}
 messages={current.messages.map(message=>({id:message.id,role:message.sender===session.owner?'user':'assistant',title:message.sender===session.owner?session.owner:current.title,content:<>{current.group?<small>{message.sender}</small>:null}<ChatMarkdown markdown={message.text}/></>}))}
 composer={{value:drafts[current.id]??'',onChange:value=>setDrafts(values=>({...values,[current.id]:value})),disabled:send.isPending||!!outgoing,placeholder:zh?'发送消息…':'Send a message…',onSend:()=>{const message={room:current.id,text:drafts[current.id]??'',transaction:crypto.randomUUID()};setOutgoing(message);send.mutate(message)}}}/>:null}/>;
}
