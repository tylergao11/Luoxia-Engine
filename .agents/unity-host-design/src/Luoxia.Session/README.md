# Luoxia.Session

**职责：** session_id、最新 asis_token、iew_revision；SessionView 快照与 delta 应用；resync 触发。  
**依赖：** Luoxia.Contracts, Luoxia.Transport。  
**禁止：** 缓存 WorldState；自签 basis_token。  
**U2 前：** 无代码。
