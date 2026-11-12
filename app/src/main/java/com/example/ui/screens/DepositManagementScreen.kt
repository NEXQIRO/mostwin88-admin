package com.example.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.DepositRequest
import com.example.ui.theme.*

@Composable
fun DepositManagementScreen(
    deposits: List<DepositRequest>
) {
    var searchQuery by remember { mutableStateOf("") }
    var filterStatus by remember { mutableStateOf("ALL") }

    val filteredDeposits = deposits.filter {
        val matchesSearch = it.playerName.contains(searchQuery, ignoreCase = true) ||
                it.trxId.contains(searchQuery, ignoreCase = true) ||
                it.senderNumber.contains(searchQuery, ignoreCase = true) ||
                it.playerId.contains(searchQuery, ignoreCase = true)
        val matchesStatus = if (filterStatus == "ALL") true else it.status.equals(filterStatus, ignoreCase = true)
        matchesSearch && matchesStatus
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        // Critical Rule Banner
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = BgInner),
            shape = RoundedCornerShape(12.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, GoldBorder)
        ) {
            Row(
                modifier = Modifier.padding(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = Icons.Default.Info,
                    contentDescription = null,
                    tint = GoldPrimary,
                    modifier = Modifier.size(26.dp)
                )
                Spacer(modifier = Modifier.width(12.dp))
                Column {
                    Text(
                        text = "DEPOSIT MONITORING ONLY",
                        color = GoldPrimary,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp
                    )
                    Text(
                        text = "সবচেয়ে গুরুত্বপূর্ণ নিয়ম: Admin কোনো Player Deposit Request Accept অথবা Reject করতে পারবে না। Deposit Verification এবং Approval শুধুমাত্র Assigned Agent করতে পারবে। Admin শুধু Monitoring ও Reports দেখবে।",
                        color = TextMain,
                        fontSize = 11.sp,
                        lineHeight = 15.sp
                    )
                }
            }
        }

        // Search & Filter
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = { Text("Search by Player, TrxID, Sender...") },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = TextMuted) },
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(10.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = GoldPrimary,
                    unfocusedBorderColor = GoldLineSubtle,
                    focusedTextColor = TextMain,
                    unfocusedTextColor = TextMain
                ),
                singleLine = true
            )

            // Status Filter Chip
            listOf("ALL", "Pending", "Approved").forEach { status ->
                FilterChip(
                    selected = filterStatus == status,
                    onClick = { filterStatus = status },
                    label = { Text(status, fontSize = 11.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = GoldPrimary,
                        selectedLabelColor = OnGold
                    )
                )
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (filteredDeposits.isEmpty()) {
                item {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = BgCard),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Box(modifier = Modifier.padding(24.dp), contentAlignment = Alignment.Center) {
                            Text("কোনো ডিপোজিট রিকোয়েস্ট নেই", color = TextDim, fontSize = 13.sp)
                        }
                    }
                }
            } else {
                items(filteredDeposits) { dep ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("deposit_item_${dep.id}"),
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
                                    Text(dep.playerName, color = TextMain, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                    Text("Player ID: ${dep.playerId}", color = TextDim, fontSize = 10.sp)
                                }

                                Surface(
                                    color = if (dep.status == "Approved") SuccessGreen.copy(alpha = 0.15f) else GoldPrimary.copy(alpha = 0.15f),
                                    shape = RoundedCornerShape(50)
                                ) {
                                    Text(
                                        text = dep.status.uppercase(),
                                        color = if (dep.status == "Approved") SuccessGreen else GoldPrimary,
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
                                    Text("Amount", color = TextMuted, fontSize = 11.sp)
                                    Text("৳ ${String.format("%,.2f", dep.amount)}", color = GoldPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                                }
                                Column {
                                    Text("Payment Method", color = TextMuted, fontSize = 11.sp)
                                    Text("${dep.method} (${dep.senderNumber})", color = TextMain, fontSize = 12.sp)
                                }
                                Column(horizontalAlignment = Alignment.End) {
                                    Text("TrxID", color = TextMuted, fontSize = 11.sp)
                                    Text(dep.trxId, color = InfoBlue, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                                }
                            }

                            Spacer(modifier = Modifier.height(8.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text("Assigned Agent: ${dep.assignedAgentName.ifBlank { "Unassigned" }}", color = TextMuted, fontSize = 11.sp)
                                Text("Verification: Agent Only", color = TextDim, fontSize = 10.sp)
                            }
                        }
                    }
                }
            }
        }
    }
}
