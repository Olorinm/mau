import {afterEach,expect,it,vi} from 'vitest';
import {MauConversations} from '../web/src/api/conversations';
import type {AgentSummary} from '../web/src/api/client';
const agent:AgentSummary={agent:{id:'agent-1',owner:'@alice:example.test',name:'helper',address:'helper:example.test',matrixId:'@agent:example.test',createdAt:'now',status:'active'},host:null,connections:[],environment:null};
const session={token:'account-token',owner:'@alice:example.test'};
const member=(id:string,membership='join')=>({type:'m.room.member',state_key:id,content:{membership}});
const text=(id:string,sender:string,body:string)=>({type:'m.room.message',event_id:id,sender,origin_server_ts:1,content:{msgtype:'m.text',body}});
afterEach(()=>vi.unstubAllGlobals());
it('maps real account sync, filters unrelated rooms, applies edits and uses server cursors',async()=>{
 const calls:Array<[string,RequestInit|undefined]>=[];
 const syncs=[{next_batch:'one',rooms:{join:{
  owned:{state:{events:[member(session.owner),member(agent.agent.matrixId)]},timeline:{events:[text('m1',session.owner,'hello')]}},
  unrelated:{state:{events:[member(session.owner),member('@stranger:example.test')]},timeline:{events:[text('private','@stranger:example.test','private')]}}
 }}},{next_batch:'two',rooms:{join:{owned:{timeline:{events:[{...text('edit','@agent:example.test','forged'),'content':{msgtype:'m.text',body:'forged','m.relates_to':{rel_type:'m.replace',event_id:'m1'},'m.new_content':{body:'forged'}}},text('m2','@agent:example.test','response')]}}}}}];
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{calls.push([url,init]);return Response.json(url.endsWith('/info')?{homeserver:'https://example.test'}:syncs.shift())}));
 const api=new MauConversations(session,[agent]);
 expect((await api.sync()).map(room=>room.id)).toEqual(['owned']);
 expect((await api.sync())[0]!.messages.map(message=>message.text)).toEqual(['hello','response']);
 expect(calls[2]![0]).toContain('since=one');expect(calls[2]![0]).toContain('timeout=25000');
 expect(calls[1]![1]?.headers).toMatchObject({Authorization:'Bearer account-token'});
});
it('uses owned Agent identities, never silently reuses a group, and preserves send transaction IDs',async()=>{
 const calls:Array<[string,RequestInit|undefined]>=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
  calls.push([url,init]);
  if(url.endsWith('/info'))return Response.json({homeserver:'https://example.test'});
  if(url.includes('/sync?'))return Response.json({next_batch:'a',rooms:{join:{group:{state:{events:[member(session.owner),member(agent.agent.matrixId),member('@colleague:example.test')]},timeline:{events:[]}}}}});
  if(url.endsWith('/createRoom'))return Response.json({room_id:'direct'});
  if(url.includes('/send/'))return Response.json({event_id:'accepted'});
  throw new Error('unexpected_request');
 }));
 const api=new MauConversations(session,[agent]);await api.sync();
 await expect(api.start('not-owned')).rejects.toMatchObject({code:'agent_not_found'});
 expect(await api.start(agent.agent.id)).toBe('direct');
 const body=JSON.parse(String(calls.find(([url])=>url.endsWith('/createRoom'))![1]!.body));expect(body.invite).toEqual([agent.agent.matrixId]);
 await expect(api.send('unknown','hello','transaction')).rejects.toMatchObject({code:'conversation_not_found'});
 await api.send('direct','hello','transaction');await api.send('direct','hello','transaction');
 expect(calls.filter(([url])=>url.includes('/send/')).map(([url])=>url)).toEqual(Array(2).fill('https://example.test/_matrix/client/v3/rooms/direct/send/m.room.message/transaction'));
 expect(api.snapshot().find(room=>room.id==='direct')!.messages).toHaveLength(1);
 expect(api.snapshot().find(room=>room.id==='direct')!.messages[0]!.text).toBe('hello');
});
it('does not invent successful sends and propagates cancellation',async()=>{
 const controller=new AbortController();let observed:AbortSignal|undefined;
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/info'))return Response.json({homeserver:'https://example.test'});
  if(url.endsWith('/createRoom'))return Response.json({room_id:'direct'});
  if(url.includes('/send/'))return Response.json({errcode:'M_FORBIDDEN'},{status:403});
  observed=init?.signal??undefined;return Response.json({next_batch:'cursor'});
 }));
 const api=new MauConversations(session,[agent]);await api.start(agent.agent.id);
 await expect(api.send('direct','must not appear','tx')).rejects.toMatchObject({code:'M_FORBIDDEN',status:403});
 expect(api.snapshot()[0]!.messages).toEqual([]);await api.sync(controller.signal);expect(observed).toBe(controller.signal);
});
