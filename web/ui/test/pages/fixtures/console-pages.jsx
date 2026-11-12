import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppShell, Navigation, ListDetailLayout, ItemList, PageHeader, SidebarHeader, CollaborationTabs, Conversation, RunMessage, FileEditor, Catalog, SaplingPlaceholder, FrontendProvider, ProfileDialog, AppCreateForm, AppCreateWizard} from '@olorinm/agent-ui/pages';
import {runFixtures} from './run-parts.mjs';
import '@olorinm/agent-ui/pages.css';
window.actions = [];
function Example() {
 const [page,setPage] = useState('messages');
 const [theme,setTheme] = useState('light');
 const [selected,setSelected] = useState();
 const [draft,setDraft] = useState('');
 const [text,setText] = useState('# Sample document');
 const [error,setError] = useState('');
 const [finished,setFinished] = useState(false);
 const [profileDialog,setProfileDialog]=useState(false);
 const [credential,setCredential] = useState('');
 return <FrontendProvider theme={theme}><AppShell brand="Workbench" logo={<SaplingPlaceholder/>} navigation={<Navigation selectedId={page} onSelect={setPage} account={{name:"Example",avatar:<span>E</span>,label:"Account menu",actions:[{id:"account",label:"Account action",onSelect:()=>window.actions.push(["account"])}]}} items={['messages','files','rich','catalog','profile','create','builder','run'].map(id=>({id,label:id}))}/> } toolbar={<button onClick={()=>setTheme(theme === 'dark' ? 'light' : 'dark')}>Theme</button>}>
 {page==='messages'&&<ListDetailLayout detailOpen={!!selected} onBack={()=>setSelected(undefined)} empty={<p>Select an item</p>} list={<><SidebarHeader title="Messages"/><CollaborationTabs label="Views" selectedId="messages" items={[{id:"messages",label:"Conversations"},{id:"contacts",label:"Contacts"}]} onSelect={()=>{}}/><ItemList label="Conversations" items={[{id:'one',title:'Research',description:'A presentation example'}]} selectedId={selected} onSelect={id=>{window.actions.push(['select',id]);setSelected(id)}}/></>}
 detail={<Conversation header={<PageHeader title="Research"/>} messages={[{id:'1',role:'assistant',title:'Example',content:<p>Caller supplied message</p>}]} composer={{value:draft,onChange:setDraft,onSend:()=>{window.actions.push(['send',draft]);setError('Caller rejected delivery')},placeholder:'Write a message'}} notice={error&&<p role="alert">{error}</p>}/>}/ >}
 {page==='profile'&&<><button onClick={()=>setProfileDialog(true)}>Edit person</button><ProfileDialog open={profileDialog} onOpenChange={setProfileDialog} title="Edit person" tabs={[{id:'identity',label:'Identity',content:<label>Name<input value={credential} onChange={e=>setCredential(e.target.value)}/></label>},{id:'runtime',label:'Runtime',content:<p>Caller-owned runtime</p>}]} actions={<button type="button" onClick={()=>{window.actions.push(['profile',credential]);setProfileDialog(false)}}>Save person</button>}/></>}
 {page==='create'&&<AppCreateForm title={credential} description={text} source="" onTitleChange={setCredential} onDescriptionChange={setText} onSourceChange={()=>{}} labels={{name:'App name',description:'Description',directory:'Directory',chooseFolder:'Choose folder'}} actions={<button onClick={()=>window.actions.push(['app',credential])}>Create app</button>}/>}
 {page==='builder'&&<AppCreateWizard title={credential} description={text} source={text} onTitleChange={setCredential} onDescriptionChange={setText} onSourceChange={setText} onCancel={()=>setPage('messages')} canRequestAgent={false} onRequestAgent={()=>window.actions.push(['build'])}/>}
 {page==='files'&&<FileEditor value={text} format="markdown" richText={false} onChange={value=>{setText(value);window.actions.push(['edit',value])}}/>}
 {page==='rich'&&<FileEditor value={text} format="markdown" richText onChange={value=>{setText(value);window.actions.push(['rich',value])}}/>}
 {page==='catalog'&&<Catalog items={[{id:'template',title:'Template',description:'Presentation without an installation service',actions:<button onClick={()=>window.actions.push(['choose','template'])}>Choose template</button>}]}/>}
 {page==='run'&&<><button onClick={()=>setFinished(!finished)}>Toggle final reply</button><Conversation messages={[{id:'stable-message',role:'assistant',title:'Agent',copyText:finished?'Final reply':'',body:<RunMessage id="stable-run" {...runFixtures.mixed} status={finished?'done':'running'} onResolveApproval={()=>{}} onResolveQuestion={()=>{}} onInsertPrompt={()=>{}}/>}]} composer={{value:'',onChange:()=>{},onSend:()=>{}}}/></>}
 </AppShell></FrontendProvider>;
}
const root=createRoot(document.getElementById('root'));root.render(<Example/>);window.dispose=()=>root.unmount();
