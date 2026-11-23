import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppShell, ListDetailLayout, Conversation, RunMessage, FileEditor, FrontendProvider, ProfileDialog, AppCreateWizard} from '@olorinm/agent-ui/pages';
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
 return <FrontendProvider theme={theme}><AppShell logo={<svg viewBox="0 0 8 8" aria-hidden="true"><rect width="8" height="8" fill="currentColor"/></svg>} label="Workbench" selectedId={page} onSelect={setPage} destinations={['messages','files','rich','profile','builder','run'].map(id=>({id,label:id,icon:<span aria-hidden="true">·</span>}))}>
 <button style={{position:'fixed',top:8,right:8,zIndex:40}} onClick={()=>setTheme(theme === 'dark' ? 'light' : 'dark')}>Theme</button>
 {page==='messages'&&<ListDetailLayout detailOpen={!!selected} onBack={()=>setSelected(undefined)} empty={<p>Select an item</p>} list={<button onClick={()=>{window.actions.push(['select','one']);setSelected('one')}}>Research</button>}
 detail={<Conversation header={<header><button onClick={()=>setSelected(undefined)}>Back</button><h2>Research</h2></header>} messages={[{id:'1',role:'assistant',title:'Example',content:<p>Caller supplied message</p>}]} composer={{value:draft,onChange:setDraft,onSend:()=>{window.actions.push(['send',draft]);setError('Caller rejected delivery')},placeholder:'Write a message'}} notice={error&&<p role="alert">{error}</p>}/>}/ >}
 {page==='profile'&&<><button onClick={()=>setProfileDialog(true)}>Edit person</button><ProfileDialog open={profileDialog} onOpenChange={setProfileDialog} title="Edit person" actions={<button type="button" onClick={()=>{window.actions.push(['profile',credential]);setProfileDialog(false)}}>Save person</button>}><label>Name<input value={credential} onChange={e=>setCredential(e.target.value)}/></label><p>Caller-owned runtime</p></ProfileDialog></>}
 {page==='builder'&&<AppCreateWizard title={credential} description={text} source={text} onTitleChange={setCredential} onDescriptionChange={setText} onSourceChange={setText} onCancel={()=>setPage('messages')} canRequestAgent={false} onRequestAgent={()=>window.actions.push(['build'])}/>}
 {page==='files'&&<FileEditor value={text} format="markdown" richText={false} onChange={value=>{setText(value);window.actions.push(['edit',value])}}/>}
 {page==='rich'&&<FileEditor value={text} format="markdown" richText onChange={value=>{setText(value);window.actions.push(['rich',value])}}/>}
 {page==='run'&&<><button onClick={()=>setFinished(!finished)}>Toggle final reply</button><Conversation messages={[{id:'stable-message',role:'assistant',title:'Agent',copyText:finished?'Final reply':'',body:<RunMessage id="stable-run" {...runFixtures.mixed} status={finished?'done':'running'} onResolveApproval={()=>{}} onResolveQuestion={()=>{}} onInsertPrompt={()=>{}}/>}]} composer={{value:'',onChange:()=>{},onSend:()=>{}}}/></>}
 </AppShell></FrontendProvider>;
}
const root=createRoot(document.getElementById('root'));root.render(<Example/>);window.dispose=()=>root.unmount();
