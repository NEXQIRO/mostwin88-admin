package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AssignmentTurnedIn
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.Agent
import com.example.data.model.WithdrawalRequest
import com.example.ui.theme.*

@Composable
fun WithdrawalManagementScreen(
    withdrawals: List<WithdrawalRequest>,
    activeAgents: List<Agent>,
    onAssignAgent: (withdrawalId: String, agentId: String) -> Unit,
    onConfirmAgentPayout: (withdrawalId: String, trxId: String) -> Unit
) {
    var searchQuery by remember { mutableStateOf("") }
    var selectedWithdrawalForAssign by remember { mutableStateOf<WithdrawalRequest?>(null) }
    var selectedWithdrawalForConfirm by remember { mutableStateOf<WithdrawalRequest?>(null) }

    val filteredWithdrawals = withdrawals.filter {
        it.playerName.contains(searchQuery, ignoreCase = true) ||
        it.playerId.contains(searchQuery, ignoreCase = true) ||
        it.receiverNumber.contains(searchQuery, ignoreCase = true) ||
        it.id.contains(searchQuery, ignoreCase = true)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        // Workflow Explanation Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = BgInner),
            shape = RoundedCornerShape(12.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, GoldBorder)
        ) {
            Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Info, contentDescription = null, tint = GoldPrimary, modifier = Modifier.size(26.dp))
                Spacer(modifier = Modifier.width(12.dp))
                Column {
                    Text(
                        text = "WITHDRAWAL DISPATCH WORKFLOW",
                        color = GoldPrimary,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp
                    )
                    Text(
                        text = "Admin receives request ➔ verifies details ➔ assigns to an active Agent ➔ Agent executes payment and confirms TrxID. Admin cannot complete without Agent confirmation.",
                        color = TextMain,
                        fontSize = 11.sp,
                        lineHeight = 15.sp
                    )
                }
            }
        }

        // Search Bar
        OutlinedTextField(
            value = searchQuery,
            onValueChange = { searchQuery = it },
            placeholder = { Text("Search by Player, ID, Receiver Number...") },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = TextMuted) },
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = GoldPrimary,
                unfocusedBorderColor = GoldLineSubtle,
                focusedTextColor = TextMain,
                unfocusedTextColor = TextMain
            ),
            singleLine = true
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (filteredWithdrawals.isEmpty()) {
                item {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = BgCard),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Box(modifier = Modifier.padding(24.dp), contentAlignment = Alignment.Center) {
                            Text("কোনো উইথড্র রিকোয়েস্ট নেই", color = TextDim, fontSize = 13.sp)
                        }
                    }
                }
            } else {
                items(filteredWithdrawals) { wth ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("withdrawal_item_${wth.id}"),
                        shape = RoundedCornerShape(14.dp),
                        colors = CardDefaults.cardColors(containerColor = BgCard),
                        border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column {
                                    Text(wth.playerName, color = TextMain, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                    Text("Player ID: ${wth.playerId} • Wallet Bal: ৳${wth.playerCurrentBalance}", color = TextDim, fontSize = 10.sp)
                                }

                                Surface(
                                    color = when (wth.status) {
                                        "Completed" -> SuccessGreen.copy(alpha = 0.15f)
                                        "AssignedToAgent" -> InfoBlue.copy(alpha = 0.15f)
                                        else -> AccentRed.copy(alpha = 0.15f)
                                    },
                                    shape = RoundedCornerShape(50)
                                ) {
                                    Text(
                                        text = wth.status.uppercase(),
                                        color = when (wth.status) {
                                            "Completed" -> SuccessGreen
                                            "AssignedToAgent" -> InfoBlue
                                            else -> AccentRed
                                        },
                                        fontSize = 10.sp,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp)
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(10.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column {
                                    Text("Withdrawal Amount", color = TextMuted, fontSize = 11.sp)
                                    Text("৳ ${String.format("%,.2f", wth.amount)}", color = AccentRed, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                                }
                                Column(horizontalAlignment = Alignment.End) {
                                    Text("Payout Details", color = TextMuted, fontSize = 11.sp)
                                    Text("${wth.method}: ${wth.receiverNumber}", color = TextMain, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                                }
                            }

                            Spacer(modifier = Modifier.height(8.dp))

                            if (wth.assignedAgentName.isNotBlank()) {
                                Text(
                                    text = "Assigned Agent: ${wth.assignedAgentName} ${if (wth.agentTrxId.isNotBlank()) "• TrxID: ${wth.agentTrxId}" else "• Awaiting Agent Payout"}",
                                    color = if (wth.agentTrxId.isNotBlank()) SuccessGreen else InfoBlue,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Medium
                                )
                            }

                            Spacer(modifier = Modifier.height(12.dp))

                            // Workflow Action Buttons
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                if (wth.status == "Pending") {
                                    Button(
                                        onClick = { selectedWithdrawalForAssign = wth },
                                        colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary),
                                        shape = RoundedCornerShape(8.dp),
                                        modifier = Modifier.weight(1f)
                                    ) {
                                        Icon(Icons.Default.Send, contentDescription = null, tint = OnGold, modifier = Modifier.size(16.dp))
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Text("Assign to Agent", color = OnGold, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                    }
                                } else if (wth.status == "AssignedToAgent") {
                                    Button(
                                        onClick = { selectedWithdrawalForConfirm = wth },
                                        colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen),
                                        shape = RoundedCornerShape(8.dp),
                                        modifier = Modifier.weight(1f)
                                    ) {
                                        Icon(Icons.Default.AssignmentTurnedIn, contentDescription = null, tint = OnGold, modifier = Modifier.size(16.dp))
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Text("Enter Agent TrxID & Complete", color = OnGold, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                    }
                                } else {
                                    OutlinedButton(
                                        onClick = {},
                                        enabled = false,
                                        shape = RoundedCornerShape(8.dp),
                                        modifier = Modifier.fillMaxWidth()
                                    ) {
                                        Text("Payout Fulfilled (Trx: ${wth.agentTrxId})", fontSize = 11.sp, color = SuccessGreen)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Dialog: Assign Agent
    selectedWithdrawalForAssign?.let { wth ->
        var selectedAgentId by remember { mutableStateOf(activeAgents.firstOrNull()?.id ?: "") }

        AlertDialog(
            onDismissRequest = { selectedWithdrawalForAssign = null },
            title = { Text("Assign Withdrawal to Agent", color = GoldPrimary, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Player: ${wth.playerName} (৳${wth.amount} via ${wth.method})", color = TextMain, fontSize = 12.sp)
                    Text("Select an Active Agent to fulfill payout:", color = TextMuted, fontSize = 11.sp)

                    activeAgents.forEach { agent ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            RadioButton(
                                selected = selectedAgentId == agent.id,
                                onClick = { selectedAgentId = agent.id }
                            )
                            Text("${agent.name} (Liquidity: ৳${agent.balance})", color = TextMain, fontSize = 12.sp)
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (selectedAgentId.isNotBlank()) {
                            onAssignAgent(wth.id, selectedAgentId)
                            selectedWithdrawalForAssign = null
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary)
                ) {
                    Text("Dispatch Task", color = OnGold, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { selectedWithdrawalForAssign = null }) { Text("Cancel") }
            },
            containerColor = BgSurface
        )
    }

    // Dialog: Confirm Agent Payout TrxID
    selectedWithdrawalForConfirm?.let { wth ->
        var trxId by remember { mutableStateOf("") }

        AlertDialog(
            onDismissRequest = { selectedWithdrawalForConfirm = null },
            title = { Text("Confirm Agent Execution", color = SuccessGreen, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Agent ${wth.assignedAgentName} has dispatched payment to ${wth.receiverNumber}.", color = TextMain, fontSize = 12.sp)
                    Text("Enter the Transaction ID provided by the Agent to finalize:", color = TextMuted, fontSize = 11.sp)

                    OutlinedTextField(
                        value = trxId,
                        onValueChange = { trxId = it },
                        label = { Text("Agent Transaction ID (TrxID)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (trxId.isNotBlank()) {
                            onConfirmAgentPayout(wth.id, trxId)
                            selectedWithdrawalForConfirm = null
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = SuccessGreen)
                ) {
                    Text("Complete Payout", color = OnGold, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { selectedWithdrawalForConfirm = null }) { Text("Cancel") }
            },
            containerColor = BgSurface
        )
    }
}
