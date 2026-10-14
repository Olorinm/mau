import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppShell, Navigation, ListDetailLayout, ItemList, PageHeader, Conversation, AuthLayout, AuthField, FileEditor, FilePreview, SettingsLayout, Catalog, SaplingPlaceholder, ConstellationPlaceholder, FrontendProvider} from '@olorinm/agent-frontend';
import '@olorinm/agent-frontend/style.css';
window.actions = [];
function Example() {
 const [page,setPage] = useState('messages');
 const [selected,setSelected] = useState();
 const [draft,setDraft] = useState('');
 const [text,setText] = useState('# Sample document');
 const [error,setError] = useState('');
 const [credential,setCredential] = useState('');
 if (page === 'login') return <AuthLayout brand="Notebook" title="Welcome" description="Caller-owned sign in" logo={<SaplingPlaceholder/>} illustration={<ConstellationPlaceholder brand="Notebook"/>} toolbar={<button onClick={()=>setPage('messages')}>Close form</button>} onSubmit={e=>{e.preventDefault(); window.actions.push(['submit',credential]);setError('Caller rejected this sign in');}}>
  <AuthField label="Account"><input autoComplete="username" value={credential} onChange={e=>setCredential(e.target.value)}/></AuthField><button type="submit">Continue</button>{error&&<p role="alert">{error}</p>}
 </AuthLayout>;
 return <FrontendProvider><AppShell brand="Workbench" logo={<SaplingPlaceholder/>} navigation={<Navigation selectedId={page} onSelect={setPage} items={['messages','files','settings','catalog','login'].map(id=>({id,label:id}))}/> } toolbar={<button onClick={()=>{document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark'?'light':'dark'}}>Theme</button>}>
 {page==='messages'&&<ListDetailLayout detailOpen={!!selected} onBack={()=>setSelected(undefined)} empty={<p>Select an item</p>} list={<><PageHeader title="Messages"/><ItemList label="Conversations" items={[{id:'one',title:'Research',description:'A presentation example'}]} selectedId={selected} onSelect={id=>{window.actions.push(['select',id]);setSelected(id)}}/></>}
 detail={<Conversation header={<PageHeader title="Research"/>} messages={[{id:'1',role:'assistant',title:'Example',content:<p>Caller supplied message</p>}]} composer={{value:draft,onChange:setDraft,onSend:()=>{window.actions.push(['send',draft]);setError('Caller rejected delivery')},placeholder:'Write a message'}} notice={error&&<p role="alert">{error}</p>}/>}/ >}
 {page==='files'&&<div style={{height:'100%',display:'grid',gridTemplateColumns:'1fr 1fr'}}><FileEditor value={text} format="markdown" onChange={value=>{setText(value);window.actions.push(['edit',value])}}/><FilePreview kind="markdown" name="Sample" content={text}/></div>}
 {page==='settings'&&<SettingsLayout title="Preferences" sections={[{id:'appearance',label:'Appearance',content:<p>Caller-owned preferences</p>}]} selectedId="appearance" onSelect={id=>window.actions.push(['setting',id])}/>}
 {page==='catalog'&&<Catalog items={[{id:'template',title:'Template',description:'Presentation without an installation service',actions:<button onClick={()=>window.actions.push(['choose','template'])}>Choose template</button>}]}/>}
 </AppShell></FrontendProvider>;
}
const root=createRoot(document.getElementById('root'));root.render(<Example/>);window.dispose=()=>root.unmount();
