package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.AppNotification
import com.example.data.model.ChatMessage
import com.example.ui.theme.*

@Composable
fun NotificationsAndChatScreen(
    notifications: List<AppNotification>,
    chatMessages: List<ChatMessage>,
    onSendNotification: (title: String, message: String, target: String) -> Unit,
    onSendChatMessage: (msg: String) -> Unit
) {
    var selectedTab by remember { mutableStateOf(0) } // 0 = Notifications, 1 = Agent Chat
    var notifTitle by remember { mutableStateOf("") }
    var notifMessage by remember { mutableStateOf("") }
    var notifTarget by remember { mutableStateOf("ALL") }

    var chatInput by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        TabRow(
            selectedTabIndex = selectedTab,
            containerColor = BgCard,
            contentColor = GoldPrimary
        ) {
            Tab(
                selected = selectedTab == 0,
                onClick = { selectedTab = 0 },
                text = { Text("App Notifications", fontWeight = FontWeight.Bold) },
                icon = { Icon(Icons.Default.Notifications, contentDescription = null) }
            )
            Tab(
                selected = selectedTab == 1,
                onClick = { selectedTab = 1 },
                text = { Text("Agent Live Chat", fontWeight = FontWeight.Bold) },
                icon = { Icon(Icons.Default.SupportAgent, contentDescription = null) }
            )
        }

        if (selectedTab == 0) {
            // Notification Broadcast Form
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = BgCard),
                shape = RoundedCornerShape(14.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("BROADCAST NOTIFICATION", color = GoldPrimary, fontSize = 11.sp, fontWeight = FontWeight.Bold)

                    OutlinedTextField(
                        value = notifTitle,
                        onValueChange = { notifTitle = it },
                        label = { Text("Title") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("input_notif_title")
                    )

                    OutlinedTextField(
                        value = notifMessage,
                        onValueChange = { notifMessage = it },
                        label = { Text("Notification Message") },
                        modifier = Modifier.fillMaxWidth().testTag("input_notif_msg")
                    )

                    Button(
                        onClick = {
                            if (notifTitle.isNotBlank() && notifMessage.isNotBlank()) {
                                onSendNotification(notifTitle, notifMessage, notifTarget)
                                notifTitle = ""
                                notifMessage = ""
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth().testTag("btn_send_broadcast")
                    ) {
                        Text("Send Broadcast", color = OnGold, fontWeight = FontWeight.Bold)
                    }
                }
            }

            Text("RECENT NOTIFICATIONS", color = TextMuted, fontSize = 11.sp, fontWeight = FontWeight.Bold)

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(notifications) { n ->
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = BgCard),
                        shape = RoundedCornerShape(10.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text(n.title, color = TextMain, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(n.message, color = TextMuted, fontSize = 11.sp)
                            Spacer(modifier = Modifier.height(4.dp))
                            Text("Target: ${n.target}", color = GoldPrimary, fontSize = 9.sp)
                        }
                    }
                }
            }
        } else {
            // Agent Chat
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.SpaceBetween
            ) {
                LazyColumn(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    items(chatMessages) { msg ->
                        val isMe = msg.senderRole == "ADMIN"
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = if (isMe) Arrangement.End else Arrangement.Start
                        ) {
                            Card(
                                shape = RoundedCornerShape(12.dp),
                                colors = CardDefaults.cardColors(
                                    containerColor = if (isMe) GoldPrimary.copy(alpha = 0.2f) else BgCard
                                ),
                                border = androidx.compose.foundation.BorderStroke(
                                    1.dp,
                                    if (isMe) GoldPrimary else GoldLineSubtle
                                ),
                                modifier = Modifier.widthIn(max = 280.dp)
                            ) {
                                Column(modifier = Modifier.padding(10.dp)) {
                                    Text(
                                        text = "${msg.senderName} (${msg.senderRole})",
                                        color = if (isMe) GoldPrimary else InfoBlue,
                                        fontWeight = FontWeight.Bold,
                                        fontSize = 11.sp
                                    )
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text(
                                        text = msg.message,
                                        color = TextMain,
                                        fontSize = 12.sp
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedTextField(
                        value = chatInput,
                        onValueChange = { chatInput = it },
                        placeholder = { Text("Message active agents...") },
                        modifier = Modifier.weight(1f).testTag("input_agent_chat"),
                        shape = RoundedCornerShape(20.dp),
                        singleLine = true
                    )

                    IconButton(
                        onClick = {
                            if (chatInput.isNotBlank()) {
                                onSendChatMessage(chatInput)
                                chatInput = ""
                            }
                        },
                        modifier = Modifier.testTag("btn_send_agent_chat")
                    ) {
                        Icon(Icons.Default.Send, contentDescription = "Send", tint = GoldPrimary)
                    }
                }
            }
        }
    }
}
