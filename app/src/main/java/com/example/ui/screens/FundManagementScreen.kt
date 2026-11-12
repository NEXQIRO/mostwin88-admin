package com.example.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.*
import com.example.ui.theme.*

@Composable
fun FundManagementScreen(
    adminProfile: AdminProfile,
    agents: List<Agent>,
    ledger: List<FundLedgerEntry>,
    onRequestFund: (amount: Double, reason: String) -> Unit,
    onAllocateFund: (agentId: String, amount: Double, note: String) -> Unit,
    onRetrieveFund: (agentId: String, amount: Double, note: String) -> Unit
) {
    var showRequestDialog by remember { mutableStateOf(false) }
    var showAllocateDialog by remember { mutableStateOf(false) }
    var showRetrieveDialog by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Balances breakdown
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = BgCard),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldBorder)
            ) {
                Column(modifier = Modifier.padding(18.dp)) {
                    Text(
                        text = "MOSTWIN88 TREASURY & FUND LEDGER",
                        color = GoldPrimary,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.2.sp
                    )

                    Spacer(modifier = Modifier.height(14.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column {
                            Text("Available Working Fund", color = TextMuted, fontSize = 11.sp)
                            Text(
                                "৳ ${String.format("%,.2f", adminProfile.balance)}",
                                color = GoldPrimary,
                                fontSize = 24.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text("Allocated to Agents", color = TextMuted, fontSize = 11.sp)
                            Text(
                                "৳ ${String.format("%,.2f", adminProfile.allocatedAgentFund)}",
                                color = InfoBlue,
                                fontSize = 24.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(18.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Button(
                            onClick = { showRequestDialog = true },
                            colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f).testTag("btn_request_from_master")
                        ) {
                            Icon(Icons.Default.AccountBalance, contentDescription = null, tint = OnGold, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Request Master", color = OnGold, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }

                        Button(
                            onClick = { showAllocateDialog = true },
                            colors = ButtonDefaults.buttonColors(containerColor = InfoBlue),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f).testTag("btn_allocate_agent")
                        ) {
                            Icon(Icons.Default.Send, contentDescription = null, tint = OnGold, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Allocate Agent", color = OnGold, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }

                        Button(
                            onClick = { showRetrieveDialog = true },
                            colors = ButtonDefaults.buttonColors(containerColor = AccentRed),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.weight(1f).testTag("btn_retrieve_agent")
                        ) {
                            Icon(Icons.Default.CallReceived, contentDescription = null, tint = OnGold, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(6.dp))
                            Text("Retrieve", color = OnGold, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }

        // Security Rules Warning Card
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = BgInner),
                shape = RoundedCornerShape(12.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
            ) {
                Row(modifier = Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Shield, contentDescription = null, tint = GoldPrimary, modifier = Modifier.size(24.dp))
                    Spacer(modifier = Modifier.width(12.dp))
                    Text(
                        text = "🔒 Security Rules: Admin cannot mint original funds. Funds must be received from Master Admin. Cannot allocate more than Available Fund.",
                        color = TextMuted,
                        fontSize = 11.sp,
                        lineHeight = 15.sp
                    )
                }
            }
        }

        // Complete Fund Ledger Table
        item {
            Text(
                text = "COMPLETE AUDIT & FUND LEDGER",
                color = TextMuted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
        }

        if (ledger.isEmpty()) {
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = BgCard),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Box(modifier = Modifier.padding(20.dp), contentAlignment = Alignment.Center) {
                        Text("কোনো ফান্ড ট্রানজেকশন রেকর্ড পাওয়া যায়নি", color = TextDim, fontSize = 12.sp)
                    }
                }
            }
        } else {
            items(ledger) { entry ->
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = BgCard),
                    shape = RoundedCornerShape(12.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
                ) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    text = entry.type,
                                    color = if (entry.type.contains("ALLOCATE")) AccentRed else SuccessGreen,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 12.sp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    text = entry.trxId,
                                    color = TextDim,
                                    fontSize = 10.sp
                                )
                            }
                            Text(
                                text = "৳ ${String.format("%,.2f", entry.amount)}",
                                color = GoldPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                        }

                        Spacer(modifier = Modifier.height(4.dp))

                        Text(
                            text = entry.note,
                            color = TextMain,
                            fontSize = 12.sp
                        )

                        Spacer(modifier = Modifier.height(4.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = "Target: ${entry.targetName}",
                                color = TextMuted,
                                fontSize = 10.sp
                            )
                            Text(
                                text = "Balance After: ৳ ${String.format("%,.0f", entry.afterBalance)}",
                                color = TextMuted,
                                fontSize = 10.sp
                            )
                        }
                    }
                }
            }
        }
    }

    // Dialog: Request from Master
    if (showRequestDialog) {
        var amountText by remember { mutableStateOf("50000") }
        var reasonText by remember { mutableStateOf("Operational Working Fund for Agent Payouts") }

        AlertDialog(
            onDismissRequest = { showRequestDialog = false },
            title = { Text("Request Fund from Master Admin", color = GoldPrimary, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = amountText,
                        onValueChange = { amountText = it },
                        label = { Text("Amount (BDT)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = reasonText,
                        onValueChange = { reasonText = it },
                        label = { Text("Reason / Notes") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val amt = amountText.toDoubleOrNull() ?: 0.0
                        if (amt > 0) {
                            onRequestFund(amt, reasonText)
                            showRequestDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary)
                ) {
                    Text("Submit Request", color = OnGold, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { showRequestDialog = false }) { Text("Cancel") }
            },
            containerColor = BgSurface
        )
    }

    // Dialog: Allocate to Agent
    if (showAllocateDialog) {
        var selectedAgentId by remember { mutableStateOf(agents.firstOrNull()?.id ?: "") }
        var amountText by remember { mutableStateOf("10000") }
        var noteText by remember { mutableStateOf("Daily payout liquidity") }

        AlertDialog(
            onDismissRequest = { showAllocateDialog = false },
            title = { Text("Allocate Fund to Agent", color = GoldPrimary, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Available Fund: ৳ ${String.format("%,.2f", adminProfile.balance)}", color = SuccessGreen, fontSize = 12.sp)

                    Text("Select Agent:", color = TextMuted, fontSize = 11.sp)
                    agents.forEach { agent ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            RadioButton(
                                selected = selectedAgentId == agent.id,
                                onClick = { selectedAgentId = agent.id }
                            )
                            Text("${agent.name} (Bal: ৳${agent.balance})", color = TextMain, fontSize = 12.sp)
                        }
                    }

                    OutlinedTextField(
                        value = amountText,
                        onValueChange = { amountText = it },
                        label = { Text("Amount (BDT)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = noteText,
                        onValueChange = { noteText = it },
                        label = { Text("Note") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val amt = amountText.toDoubleOrNull() ?: 0.0
                        if (amt > 0 && selectedAgentId.isNotBlank()) {
                            onAllocateFund(selectedAgentId, amt, noteText)
                            showAllocateDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = InfoBlue)
                ) {
                    Text("Allocate", color = OnGold, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { showAllocateDialog = false }) { Text("Cancel") }
            },
            containerColor = BgSurface
        )
    }

    // Dialog: Retrieve Unused Fund
    if (showRetrieveDialog) {
        var selectedAgentId by remember { mutableStateOf(agents.firstOrNull()?.id ?: "") }
        var amountText by remember { mutableStateOf("5000") }
        var noteText by remember { mutableStateOf("Retrieve unused liquidity back to Admin balance") }

        AlertDialog(
            onDismissRequest = { showRetrieveDialog = false },
            title = { Text("Retrieve Unused Agent Fund", color = AccentRed, fontWeight = FontWeight.Bold) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Select Agent:", color = TextMuted, fontSize = 11.sp)
                    agents.forEach { agent ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            RadioButton(
                                selected = selectedAgentId == agent.id,
                                onClick = { selectedAgentId = agent.id }
                            )
                            Text("${agent.name} (Available: ৳${agent.balance})", color = TextMain, fontSize = 12.sp)
                        }
                    }

                    OutlinedTextField(
                        value = amountText,
                        onValueChange = { amountText = it },
                        label = { Text("Amount to Retrieve (BDT)") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = noteText,
                        onValueChange = { noteText = it },
                        label = { Text("Note") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val amt = amountText.toDoubleOrNull() ?: 0.0
                        if (amt > 0 && selectedAgentId.isNotBlank()) {
                            onRetrieveFund(selectedAgentId, amt, noteText)
                            showRetrieveDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = AccentRed)
                ) {
                    Text("Retrieve", color = OnGold, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { showRetrieveDialog = false }) { Text("Cancel") }
            },
            containerColor = BgSurface
        )
    }
}
