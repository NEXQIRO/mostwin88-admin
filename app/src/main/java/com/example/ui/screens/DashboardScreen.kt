package com.example.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.data.model.*
import com.example.ui.theme.*

@Composable
fun DashboardScreen(
    adminProfile: AdminProfile,
    agents: List<Agent>,
    affiliates: List<Affiliate>,
    players: List<Player>,
    deposits: List<DepositRequest>,
    withdrawals: List<WithdrawalRequest>,
    ledger: List<FundLedgerEntry>,
    onRequestFundClick: () -> Unit,
    onNavigateToSection: (String) -> Unit
) {
    val totalDepositAmount = deposits.filter { it.status == "Approved" }.sumOf { it.amount }
    val totalWithdrawalAmount = withdrawals.filter { it.status == "Completed" }.sumOf { it.amount }
    val pendingWithdrawCount = withdrawals.count { it.status == "Pending" || it.status == "AssignedToAgent" }
    val pendingDepositCount = deposits.count { it.status == "Pending" }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Welcome & Working Fund Banner
        item {
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("admin_working_fund_card"),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = BgCard),
                border = androidx.compose.foundation.BorderStroke(1.dp, GoldBorder)
            ) {
                Column(
                    modifier = Modifier.padding(18.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(
                                text = "ADMIN WORKING FUND",
                                color = TextMuted,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = 1.2.sp
                            )
                            Text(
                                text = "৳ ${String.format("%,.2f", adminProfile.balance)}",
                                color = GoldPrimary,
                                fontSize = 28.sp,
                                fontWeight = FontWeight.Black
                            )
                        }

                        Button(
                            onClick = onRequestFundClick,
                            colors = ButtonDefaults.buttonColors(containerColor = GoldPrimary),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.testTag("request_fund_quick_btn")
                        ) {
                            Icon(
                                imageVector = Icons.Default.AddCircle,
                                contentDescription = "Add",
                                tint = OnGold,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = "Request Fund",
                                color = OnGold,
                                fontWeight = FontWeight.Bold,
                                fontSize = 12.sp
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Allocated to Agents: ৳ ${String.format("%,.2f", adminProfile.allocatedAgentFund)}",
                            color = InfoBlue,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            text = "Parent: Master Admin (Active)",
                            color = SuccessGreen,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
        }

        // Stats Grid
        item {
            Text(
                text = "SYSTEM METRICS OVERVIEW",
                color = TextMuted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp
            )
        }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    StatCard(
                        title = "TOTAL AGENTS",
                        value = "${agents.size}",
                        icon = Icons.Default.SupportAgent,
                        color = GoldPrimary,
                        modifier = Modifier.weight(1f),
                        onClick = { onNavigateToSection("Agents") }
                    )
                    StatCard(
                        title = "AFFILIATES",
                        value = "${affiliates.size}",
                        icon = Icons.Default.Share,
                        color = InfoBlue,
                        modifier = Modifier.weight(1f),
                        onClick = { onNavigateToSection("Affiliates") }
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    StatCard(
                        title = "TOTAL PLAYERS",
                        value = "${players.size}",
                        icon = Icons.Default.People,
                        color = SuccessGreen,
                        modifier = Modifier.weight(1f),
                        onClick = { onNavigateToSection("Players") }
                    )
                    StatCard(
                        title = "PENDING WITHDRAWS",
                        value = "$pendingWithdrawCount",
                        icon = Icons.Default.HourglassTop,
                        color = AccentRed,
                        modifier = Modifier.weight(1f),
                        onClick = { onNavigateToSection("Withdrawals") }
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    StatCard(
                        title = "TOTAL DEPOSITS",
                        value = "৳ ${String.format("%,.0f", totalDepositAmount)}",
                        icon = Icons.Default.ArrowDownward,
                        color = SuccessGreen,
                        modifier = Modifier.weight(1f),
                        onClick = { onNavigateToSection("Deposits") }
                    )
                    StatCard(
                        title = "TOTAL WITHDRAWALS",
                        value = "৳ ${String.format("%,.0f", totalWithdrawalAmount)}",
                        icon = Icons.Default.ArrowUpward,
                        color = AccentRed,
                        modifier = Modifier.weight(1f),
                        onClick = { onNavigateToSection("Withdrawals") }
                    )
                }
            }
        }

        // Recent System Activity & Ledger Feed
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "RECENT TRANSACTIONS & TRANSFERS",
                    color = TextMuted,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp
                )
                TextButton(onClick = { onNavigateToSection("Fund Management") }) {
                    Text("View Full Ledger", color = GoldPrimary, fontSize = 12.sp)
                }
            }
        }

        if (ledger.isEmpty()) {
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = BgCard),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Box(modifier = Modifier.padding(24.dp), contentAlignment = Alignment.Center) {
                        Text("কোনো সাম্প্রতিক ট্রানজেকশন নেই", color = TextDim, fontSize = 13.sp)
                    }
                }
            }
        } else {
            items(ledger.take(5)) { entry ->
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = BgCard),
                    shape = RoundedCornerShape(12.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(14.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .size(38.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (entry.type.contains("ALLOCATE")) AccentRed.copy(alpha = 0.2f)
                                        else SuccessGreen.copy(alpha = 0.2f)
                                    ),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    imageVector = if (entry.type.contains("ALLOCATE")) Icons.Default.NorthEast else Icons.Default.SouthWest,
                                    contentDescription = null,
                                    tint = if (entry.type.contains("ALLOCATE")) AccentRed else SuccessGreen,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                            Spacer(modifier = Modifier.width(12.dp))
                            Column {
                                Text(
                                    text = entry.targetName.ifBlank { entry.type },
                                    color = TextMain,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp
                                )
                                Text(
                                    text = entry.note,
                                    color = TextMuted,
                                    fontSize = 11.sp
                                )
                            }
                        }

                        Column(horizontalAlignment = Alignment.End) {
                            Text(
                                text = "৳ ${String.format("%,.2f", entry.amount)}",
                                color = if (entry.type.contains("ALLOCATE")) AccentRed else GoldPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                            Text(
                                text = "Bal: ৳${String.format("%,.0f", entry.afterBalance)}",
                                color = TextDim,
                                fontSize = 10.sp
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun StatCard(
    title: String,
    value: String,
    icon: ImageVector,
    color: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Card(
        modifier = modifier
            .clickable { onClick() }
            .testTag("stat_card_${title.lowercase().replace(" ", "_")}"),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = BgCard),
        border = androidx.compose.foundation.BorderStroke(1.dp, GoldLineSubtle)
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(color.copy(alpha = 0.15f))
                    .border(1.dp, color.copy(alpha = 0.4f), RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = color,
                    modifier = Modifier.size(22.dp)
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column {
                Text(
                    text = title,
                    color = TextMuted,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = value,
                    color = TextMain,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
