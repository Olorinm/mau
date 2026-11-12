import {createContext,useContext,type ReactNode} from "react";
import type {ChatMarkdownRenderOptions} from "./chat-markdown-renderer";
export type ResourceOperations = Pick<ChatMarkdownRenderOptions,"resolveImageUrl"|"onDownloadImage"|"downloadErrorMessage"|"onPreviewImage"|"onSaveImageArtifact"> & {resolveArtifactUrl?(id:string):string|undefined};
const Context=createContext<ResourceOperations>({});
export const useResourceOperations=()=>useContext(Context);
export function ResourceOperationsProvider({value,children}:{value:ResourceOperations;children:ReactNode}){return <Context.Provider value={value}>{children}</Context.Provider>}
