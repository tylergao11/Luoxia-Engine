# Luoxia.Dialogue

**职责：** dialogue.start / dialogue.continue 输入；消费 dialogue.reply 与 SessionView.dialogues。  
**依赖：** Luoxia.Session。  
**规则：** Reply 低延迟；权威 turns 以同 revision SessionView 为准。  
**U2 前：** 无代码。
